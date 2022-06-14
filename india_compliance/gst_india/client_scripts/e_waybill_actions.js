function setup_e_waybill_actions(doctype) {
    const gst_settings = frappe.boot.gst_settings;
    if (
        !gst_settings.enable_e_waybill ||
        (doctype == "Delivery Note" && !gst_settings.enable_e_waybill_from_dn)
    )
        return;

    frappe.ui.form.on(doctype, {
        setup(frm) {
            if (!gst_settings.enable_api) return;

            frappe.realtime.on("e_waybill_pdf_attached", () => {
                frm.reload_doc();
                frappe.show_alert({
                    indicator: "green",
                    message: __("e-Waybill PDF attached successfully"),
                });
            });
        },
        refresh(frm) {
            if (
                frm.doc.docstatus != 1 ||
                frm.is_dirty() ||
                !is_e_waybill_applicable(frm) ||
                (frm.doctype === "Delivery Note" && !frm.doc.customer_address)
            )
                return;

            if (!frm.doc.ewaybill) {
                if (frappe.perm.has_perm(frm.doctype, 0, "submit", frm.doc.name)) {
                    frm.add_custom_button(
                        __("Generate"),
                        () =>
                            show_generate_e_waybill_dialog(
                                frm,
                                gst_settings.enable_api
                            ),
                        "e-Waybill"
                    );
                }

                if (has_e_waybill_threshold_met(frm) && !frm.doc.is_return) {
                    frm.dashboard.add_comment(
                        "e-Waybill is applicable for this invoice and not yet generated or updated.",
                        "yellow",
                        true
                    );
                }

                return;
            }

            if (!gst_settings.enable_api || !is_e_waybill_generated_using_api(frm)) {
                return;
            }

            frm.set_df_property("ewaybill", "allow_on_submit", 0);

            if (
                frappe.perm.has_perm(frm.doctype, 0, "submit", frm.doc.name) &&
                is_e_waybill_valid(frm)
            ) {
                frm.add_custom_button(
                    __("Update Vehicle Info"),
                    () => show_update_vehicle_info_dialog(frm),
                    "e-Waybill"
                );

                frm.add_custom_button(
                    __("Update Transporter"),
                    () => show_update_transporter_dialog(frm),
                    "e-Waybill"
                );
            }

            if (
                frappe.perm.has_perm(frm.doctype, 0, "cancel", frm.doc.name) &&
                is_e_waybill_cancellable(frm)
            ) {
                frm.add_custom_button(
                    __("Cancel"),
                    () => show_cancel_e_waybill_dialog(frm),
                    "e-Waybill"
                );
            }

            if (frappe.model.can_print("e-Waybill Log")) {
                frm.add_custom_button(
                    __("Print"),
                    () => {
                        frappe.set_route("print", "e-Waybill Log", frm.doc.ewaybill);
                    },
                    "e-Waybill"
                );
            }

            if (frappe.perm.has_perm(frm.doctype, 0, "write", frm.doc.name)) {
                frm.add_custom_button(
                    __("Attach"),
                    () => fetch_e_waybill_data(frm, { attach: 1 }, () => frm.refresh()),
                    "e-Waybill"
                );
            }
        },
        async on_submit(frm) {
            if (
                // threshold is only met for Sales Invoice
                !has_e_waybill_threshold_met(frm) ||
                frm.doc.ewaybill ||
                frm.doc.is_return ||
                !gst_settings.enable_api ||
                !gst_settings.auto_generate_e_waybill ||
                (gst_settings.enable_e_invoice &&
                    gst_settings.auto_generate_e_invoice) ||
                !is_e_waybill_applicable(frm)
            )
                return;

            frappe.show_alert(__("Attempting to generate e-Waybill"));

            await frappe.xcall(
                "india_compliance.gst_india.utils.e_waybill.generate_e_waybill",
                { doctype: frm.doctype, docname: frm.doc.name }
            );
        },
        before_cancel(frm) {
            // if IRN is present, e-Waybill gets cancelled in e-Invoice action
            if (!gst_settings.enable_api || frm.doc.irn || !frm.doc.ewaybill) return;

            frappe.validated = false;

            return new Promise(resolve => {
                const continueCancellation = () => {
                    frappe.validated = true;
                    resolve();
                };

                if (!is_e_waybill_cancellable(frm)) {
                    const d = frappe.warn(
                        __("Cannot Cancel e-Waybill"),
                        __(
                            `The e-Waybill created against this invoice cannot be
                            cancelled.<br><br>

                            Do you want to continue anyway?`
                        ),
                        continueCancellation,
                        __("Yes")
                    );

                    d.set_secondary_action_label(__("No"));
                    return;
                }

                return show_cancel_e_waybill_dialog(frm, continueCancellation);
            });
        },
    });
}
function fetch_e_waybill_data(frm, args, callback) {
    if (!args) args = {};

    frappe.call({
        method: "india_compliance.gst_india.utils.e_waybill.fetch_e_waybill_data",
        args: { doctype: frm.doctype, docname: frm.doc.name, ...args },
        callback,
    });
}

function show_generate_e_waybill_dialog(frm, enable_api) {
    const generate_action = values => {
        frappe.call({
            method: "india_compliance.gst_india.utils.e_waybill.generate_e_waybill",
            args: {
                doctype: frm.doctype,
                docname: frm.doc.name,
                values,
            },
            callback: () => frm.refresh(),
        });
    };

    const json_action_label = __("Download JSON");
    const json_action = async values => {
        const ewb_data = await frappe.xcall(
            "india_compliance.gst_india.utils.e_waybill.generate_e_waybill_json",
            {
                doctype: frm.doctype,
                docnames: frm.doc.name,
                values,
            }
        );

        frm.refresh();
        trigger_file_download(ewb_data, get_e_waybill_file_name(frm.doc.name));
    };

    const fields = [
        {
            label: "Transporter",
            fieldname: "transporter",
            fieldtype: "Link",
            options: "Supplier",
            default: frm.doc.transporter,
            get_query: () => {
                return {
                    filters: {
                        is_transporter: 1,
                    },
                };
            },
            onchange: () => update_gst_tranporter_id(d),
        },
        {
            label: "GST Transporter ID",
            fieldname: "gst_transporter_id",
            fieldtype: "Data",
            default:
                frm.doc.gst_transporter_id && frm.doc.gst_transporter_id.length == 15
                    ? frm.doc.gst_transporter_id
                    : "",
            onchange: () => update_generate_dialog_title(d),
        },
        {
            label: "Vehicle No",
            fieldname: "vehicle_no",
            fieldtype: "Data",
            default: frm.doc.vehicle_no,
            onchange: () => update_generate_dialog_title(d),
        },
        {
            label: "Distance (in km)",
            fieldname: "distance",
            fieldtype: "Float",
            default: frm.doc.distance,
            description:
                "Set as zero to update distance as per the e-Waybill portal (if available)",
        },
        {
            fieldtype: "Column Break",
        },
        {
            label: "Transport Receipt No",
            fieldname: "lr_no",
            fieldtype: "Data",
            default: frm.doc.lr_no,
            onchange: () => update_generate_dialog_title(d),
        },
        {
            label: "Transport Receipt Date",
            fieldname: "lr_date",
            fieldtype: "Date",
            default: frm.doc.lr_date,
            mandatory_depends_on: "eval:doc.lr_no",
        },
        {
            label: "Mode Of Transport",
            fieldname: "mode_of_transport",
            fieldtype: "Select",
            options: `\nRoad\nAir\nRail\nShip`,
            default: frm.doc.mode_of_transport,
            onchange: () => {
                update_generate_dialog_title(d);
                update_vehicle_type(d);
            },
        },
        {
            label: "GST Vehicle Type",
            fieldname: "gst_vehicle_type",
            fieldtype: "Select",
            options: `Regular\nOver Dimensional Cargo (ODC)`,
            depends_on: 'eval:["Road", "Ship"].includes(doc.mode_of_transport)',
            read_only_depends_on: "eval: doc.mode_of_transport == 'Ship'",
            default: frm.doc.gst_vehicle_type,
        },
        {
            fieldtype: "Section Break",
        },
        {
            fieldname: "gst_category",
            label: "GST Category",
            fieldtype: "Select",
            options:
                "\nRegistered Regular\nRegistered Composition\nUnregistered\nSEZ\nOverseas\nConsumer\nDeemed Export\nUIN Holders",
            default: frm.doc.gst_category,
        },
        {
            fieldtype: "Column Break",
        },
        {
            fieldname: "export_type",
            label: "Export Type",
            fieldtype: "Select",
            depends_on: 'eval:in_list(["SEZ", "Overseas"], doc.gst_category)',
            options: "\nWith Payment of Tax\nWithout Payment of Tax",
            default: frm.doc.export_type,
        },
    ];

    if (frm.doctype === "Delivery Note") {
        const same_gstin = frm.doc.billing_address_gstin == frm.doc.company_gstin;
        let options;

        if (frm.doc.is_return) {
            if (same_gstin) {
                options = ["For Own Use", "Exhibition or Fairs"];
            } else {
                options = ["Job Work Returns", "SKD/CKD"];
            }
        } else {
            if (same_gstin) {
                options = [
                    "For Own Use",
                    "Exhibition or Fairs",
                    "Line Sales",
                    "Recipient Not Known",
                ];
            } else {
                options = ["Job Work", "SKD/CKD"];
            }
        }

        fields.push({
            label: "Sub Supply Type",
            fieldname: "sub_supply_type",
            fieldtype: "Select",
            options: options.join("\n"),
            default: options[0],
            reqd: 1,
        });
    }

    const d = new frappe.ui.Dialog({
        title: __(get_generate_dialog_title(frm.doc)),
        fields,
        primary_action_label: enable_api ? __("Generate") : json_action_label,
        primary_action(values) {
            d.hide();

            if (enable_api) {
                generate_action(values);
            } else {
                json_action(values);
            }
        },
        secondary_action_label: enable_api ? json_action_label : null,
        secondary_action: enable_api
            ? () => {
                  d.hide();
                  json_action(d.get_values());
              }
            : null,
    });

    d.show();
}

function show_cancel_e_waybill_dialog(frm, callback) {
    const d = new frappe.ui.Dialog({
        title: __("Cancel e-Waybill"),
        fields: [
            {
                label: "e-Waybill",
                fieldname: "ewaybill",
                fieldtype: "Data",
                read_only: 1,
                default: frm.doc.ewaybill,
            },
            {
                label: "Reason",
                fieldname: "reason",
                fieldtype: "Select",
                reqd: 1,
                default: "Data Entry Mistake",
                options: [
                    "Duplicate",
                    "Order Cancelled",
                    "Data Entry Mistake",
                    "Others",
                ],
            },
            {
                label: "Remark",
                fieldname: "remark",
                fieldtype: "Data",
                mandatory_depends_on: "eval: doc.reason == 'Others'",
            },
        ],
        primary_action_label: __("Cancel"),
        primary_action(values) {
            frappe.call({
                method: "india_compliance.gst_india.utils.e_waybill.cancel_e_waybill",
                args: {
                    doctype: frm.doctype,
                    docname: frm.doc.name,
                    values,
                },
                callback: () => {
                    frm.refresh();
                    if (callback) callback();
                },
            });
            d.hide();
        },
    });

    d.show();
}

function show_update_vehicle_info_dialog(frm) {
    const d = new frappe.ui.Dialog({
        title: __("Update Vehicle Information"),
        fields: [
            {
                label: "e-Waybill",
                fieldname: "ewaybill",
                fieldtype: "Data",
                read_only: 1,
                default: frm.doc.ewaybill,
            },
            {
                label: "Vehicle No",
                fieldname: "vehicle_no",
                fieldtype: "Data",
                default: frm.doc.vehicle_no,
                mandatory_depends_on:
                    "eval: ['Road', 'Ship'].includes(doc.mode_of_transport)",
            },
            {
                label: "Transport Receipt No",
                fieldname: "lr_no",
                fieldtype: "Data",
                default: frm.doc.lr_no,
                mandatory_depends_on:
                    "eval: ['Rail', 'Air', 'Ship'].includes(doc.mode_of_transport)",
            },
            {
                fieldtype: "Column Break",
            },
            {
                label: "Mode Of Transport",
                fieldname: "mode_of_transport",
                fieldtype: "Select",
                options: `\nRoad\nAir\nRail\nShip`,
                default: frm.doc.mode_of_transport,
                mandatory_depends_on: "eval: doc.lr_no",
                onchange: () => update_vehicle_type(d),
            },
            {
                label: "GST Vehicle Type",
                fieldname: "gst_vehicle_type",
                fieldtype: "Select",
                options: `Regular\nOver Dimensional Cargo (ODC)`,
                depends_on: 'eval:["Road", "Ship"].includes(doc.mode_of_transport)',
                read_only_depends_on: "eval: doc.mode_of_transport == 'Ship'",
                default: frm.doc.gst_vehicle_type,
            },
            {
                label: "Transport Receipt Date",
                fieldname: "lr_date",
                fieldtype: "Date",
                default: frm.doc.lr_date,
                mandatory_depends_on: "eval:doc.lr_no",
            },
            {
                fieldtype: "Section Break",
            },
            {
                fieldname: "reason",
                label: "Reason",
                fieldtype: "Select",
                options: [
                    "Due to Break Down",
                    "Due to Trans Shipment",
                    "First Time",
                    "Others",
                ],
                reqd: 1,
            },
            {
                label: "Update e-Waybill Print/Data",
                fieldname: "update_e_waybill_data",
                fieldtype: "Check",
                default: frappe.boot.gst_settings.fetch_e_waybill_data,
            },
            {
                fieldtype: "Column Break",
            },
            {
                fieldname: "remark",
                label: "Remark",
                fieldtype: "Data",
                mandatory_depends_on: 'eval: doc.reason == "Others"',
            },
        ],
        primary_action_label: __("Update"),
        primary_action(values) {
            frappe.call({
                method: "india_compliance.gst_india.utils.e_waybill.update_vehicle_info",
                args: {
                    doctype: frm.doctype,
                    docname: frm.doc.name,
                    values,
                },
                callback: () => frm.refresh(),
            });
            d.hide();
        },
    });

    d.show();
}

function show_update_transporter_dialog(frm) {
    const d = new frappe.ui.Dialog({
        title: __("Update Transporter"),
        fields: [
            {
                label: "e-Waybill",
                fieldname: "ewaybill",
                fieldtype: "Data",
                read_only: 1,
                default: frm.doc.ewaybill,
            },
            {
                label: "Transporter",
                fieldname: "transporter",
                fieldtype: "Link",
                options: "Supplier",
                default: frm.doc.transporter,
                get_query: () => {
                    return {
                        filters: {
                            is_transporter: 1,
                        },
                    };
                },
                onchange: () => update_gst_tranporter_id(d),
            },
            {
                label: "GST Transporter ID",
                fieldname: "gst_transporter_id",
                fieldtype: "Data",
                reqd: 1,
                default:
                    frm.doc.gst_transporter_id &&
                    frm.doc.gst_transporter_id.length == 15
                        ? frm.doc.gst_transporter_id
                        : "",
            },
            {
                label: "Update e-Waybill Print/Data",
                fieldname: "update_e_waybill_data",
                fieldtype: "Check",
                default: frappe.boot.gst_settings.fetch_e_waybill_data,
            },
        ],
        primary_action_label: __("Update"),
        primary_action(values) {
            frappe.call({
                method: "india_compliance.gst_india.utils.e_waybill.update_transporter",
                args: {
                    doctype: frm.doctype,
                    docname: frm.doc.name,
                    values,
                },
                callback: () => frm.refresh(),
            });
            d.hide();
        },
    });

    d.show();
}

function is_e_waybill_valid(frm) {
    const e_waybill_info = frm.doc.__onload && frm.doc.__onload.e_waybill_info;
    return (
        e_waybill_info &&
        (!e_waybill_info.valid_upto ||
            frappe.datetime
                .convert_to_user_tz(e_waybill_info.valid_upto, false)
                .diff() > 0)
    );
}

function has_e_waybill_threshold_met(frm) {
    if (
        frm.doc.doctype == "Sales Invoice" &&
        Math.abs(frm.doc.base_grand_total) >=
            frappe.boot.gst_settings.e_waybill_threshold
    )
        return true;
}

function is_e_waybill_applicable(frm) {
    // means company is Indian and not Unregistered
    if (!frm.doc.company_gstin) return;

    // atleast one item is not a service
    for (let item of frm.doc.items) {
        if (!item.gst_hsn_code.startsWith("99")) return true;
    }
}

function is_e_waybill_cancellable(frm) {
    const e_waybill_info = frm.doc.__onload && frm.doc.__onload.e_waybill_info;
    return (
        e_waybill_info &&
        frappe.datetime
            .convert_to_user_tz(e_waybill_info.created_on, false)
            .add("days", 1)
            .diff() > 0
    );
}

function is_e_waybill_generated_using_api(frm) {
    const e_waybill_info = frm.doc.__onload && frm.doc.__onload.e_waybill_info;
    return e_waybill_info && e_waybill_info.created_on;
}

async function update_gst_tranporter_id(dialog) {
    const transporter = dialog.get_value("transporter");
    const { message: response } = await frappe.db.get_value(
        "Supplier",
        transporter,
        "gst_transporter_id"
    );

    dialog.set_value("gst_transporter_id", response.gst_transporter_id);
}

function update_generate_dialog_title(dialog) {
    const title = get_generate_dialog_title(dialog.get_values(true));
    dialog.set_df_property(
        "gst_transporter_id",
        "reqd",
        title == "Generate e-Waybill" ? 0 : 1
    );
    dialog.set_title(__(title));
}

function get_generate_dialog_title(doc) {
    return `Generate e-Waybill${
        are_transport_details_available(doc) ? "" : " (Part A)"
    }`;
}

function are_transport_details_available(doc) {
    return (
        (doc.mode_of_transport == "Road" && doc.vehicle_no) ||
        (["Air", "Rail"].includes(doc.mode_of_transport) && doc.lr_no) ||
        (doc.mode_of_transport == "Ship" && doc.lr_no && doc.vehicle_no)
    );
}

function update_vehicle_type(dialog) {
    dialog.set_value("gst_vehicle_type", get_vehicle_type(dialog.get_values(true)));
}

/********
 * Utils
 *******/

function trigger_file_download(file_content, file_name) {
    let type = "application/json;charset=utf-8";

    if (!file_name.endsWith(".json")) {
        type = "application/octet-stream";
    }

    const blob = new Blob([file_content], { type: type });

    // Create a link and set the URL using `createObjectURL`
    const link = document.createElement("a");
    link.style.display = "none";
    link.href = URL.createObjectURL(blob);
    link.download = file_name;

    // It needs to be added to the DOM so it can be clicked
    document.body.appendChild(link);
    link.click();

    // To make this work on Firefox we need to wait
    // a little while before removing it.
    setTimeout(() => {
        URL.revokeObjectURL(link.href);
        link.parentNode.removeChild(link);
    }, 0);
}

function get_e_waybill_file_name(docname) {
    let prefix = "Bulk";
    if (docname) {
        prefix = docname.replaceAll(/[^\w_.)( -]/g, "");
    }

    return `${prefix}_e-Waybill_Data_${frappe.utils.get_random(5)}.json`;
}