// Seeds the big test flows in the test org (see session.js). Never activates anything and
// never logs URLs or tokens.
//
// UAT_Discounts_A–F each get three new versions to merge three ways: a
// base of about thirty elements, "ours" (a loyalty bonus) and "theirs" (a
// risk hold), which change some of the same things differently.
//
// UAT_Case_Triage_Record, UAT_Case_Triage_Sub and UAT_Case_Screen do
// related work from different starts (a Case trigger, a `caseRecord` input
// and a screen flow's `recordId`), to merge across flows by mapping one's
// variables onto the other's. The record-triggered one is never activated.
//
// Order_Discounts (base, ours, theirs) and Partner_Discounts are the same
// kind of flow under plain names, for the help videos to show.
//
//   node seed-flows.js               create what isn't in the org yet
//   node seed-flows.js --dry-run     only say what it would create
//   node seed-flows.js --dump=DIR    also write each flow as DIR/<Flow>/vN.json
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ALIAS, ORG, NS } = require("./session");
const API = `${ORG}/services/data/v67.0`;
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const DUMP = (args.find((arg) => arg.startsWith("--dump=")) || "").slice(7);

// ---- Building flow metadata -------------------------------------------

const FREE_FORM = [
  { name: "CanvasMode", value: { stringValue: "FREE_FORM_CANVAS" } },
  { name: "BuilderType", value: { stringValue: "LightningFlowBuilder" } }
];
const ref = (name) => ({ elementReference: name });
const to = (target) => (target ? { targetReference: target } : undefined);
const label = (name) => name.replace(/_/g, " ");
function value(given) {
  if (given && typeof given === "object") return given;
  if (typeof given === "number") return { numberValue: given };
  if (typeof given === "boolean") return { booleanValue: given };
  return { stringValue: given };
}
const conditions = (list) =>
  list.map(([left, operator, right]) => ({
    leftValueReference: left,
    operator,
    rightValue: value(right)
  }));
const filters = (list) =>
  list.map(([field, operator, given]) => ({
    field,
    operator,
    value: value(given)
  }));
const fields = (list) =>
  list.map(([field, given]) => ({ field, value: value(given) }));

const assign = (name, items, next) => [
  "assignments",
  {
    name,
    assignmentItems: items.map(([target, operator, given]) => ({
      assignToReference: target,
      operator,
      value: value(given)
    })),
    connector: to(next)
  }
];
// rules: [name, conditions, next, logic?]
const decide = (name, rules, otherwise, otherwiseLabel = "Otherwise") => [
  "decisions",
  {
    name,
    rules: rules.map(([rule, list, next, logic]) => ({
      name: rule,
      label: label(rule),
      conditionLogic: logic || "and",
      conditions: conditions(list),
      connector: to(next)
    })),
    defaultConnectorLabel: otherwiseLabel,
    defaultConnector: to(otherwise)
  }
];
const lookup = (name, object, list, next, fault, many) => [
  "recordLookups",
  {
    name,
    object,
    filterLogic: "and",
    filters: filters(list),
    getFirstRecordOnly: !many,
    storeOutputAutomatically: true,
    connector: to(next),
    faultConnector: to(fault)
  }
];
// input: a record variable's name, or { object, filters } to find them
// A record variable (only $Record may be updated with field values
// directly) or { object, filters }.
const update = (name, input, list, next, fault) => [
  "recordUpdates",
  {
    name,
    ...(typeof input === "string"
      ? { inputReference: input }
      : {
          object: input.object,
          filterLogic: "and",
          filters: filters(input.filters)
        }),
    inputAssignments: fields(list),
    connector: to(next),
    faultConnector: to(fault)
  }
];
const create = (name, object, list, next, fault) => [
  "recordCreates",
  {
    name,
    object,
    inputAssignments: fields(list),
    storeOutputAutomatically: true,
    connector: to(next),
    faultConnector: to(fault)
  }
];
const loop = (name, collection, item, next, done) => [
  "loops",
  {
    name,
    collectionReference: collection,
    assignNextValueToReference: item,
    iterationOrder: "Asc",
    nextValueConnector: to(next),
    noMoreValuesConnector: to(done)
  }
];
const screen = (name, screenFields, next) => [
  "screens",
  {
    name,
    allowBack: true,
    allowFinish: true,
    allowPause: false,
    showFooter: true,
    showHeader: true,
    fields: screenFields,
    connector: to(next)
  }
];
const text = (name, html) => ({
  name,
  fieldType: "DisplayText",
  fieldText: html
});
const input = (name, fieldText) => ({
  name,
  dataType: "String",
  fieldType: "InputField",
  fieldText,
  isRequired: false
});

const variable = (name, dataType, extra = {}) => ({
  name,
  dataType,
  isCollection: false,
  isInput: false,
  isOutput: false,
  ...(dataType === "Number" || dataType === "Currency" ? { scale: 2 } : {}),
  ...extra
});
const IN = { isInput: true };
const OUT = { isOutput: true };

const targetsOf = (element) =>
  [
    element.connector,
    element.defaultConnector,
    element.nextValueConnector,
    element.noMoreValuesConnector,
    ...(element.rules || []).map((rule) => rule.connector),
    element.faultConnector
  ]
    .filter(Boolean)
    .map((connector) => connector.targetReference);

// Layers along the longest path from the start, loops ignored; each layer
// is centred and ordered as a walk from the start first meets them.
function layout(elements, first) {
  const byName = new Map(
    elements.map(([, element]) => [element.name, element])
  );
  const seen = new Map();
  const order = [];
  const post = [];
  const forward = new Map();
  const visit = (name) => {
    seen.set(name, "open");
    order.push(name);
    forward.set(name, []);
    for (const target of targetsOf(byName.get(name))) {
      if (!byName.has(target) || seen.get(target) === "open") continue;
      forward.get(name).push(target);
      if (!seen.has(target)) visit(target);
    }
    seen.set(name, "done");
    post.push(name);
  };
  visit(first);
  const depth = new Map([[first, 1]]);
  for (const name of post.reverse()) {
    for (const target of forward.get(name)) {
      depth.set(target, Math.max(depth.get(target) || 0, depth.get(name) + 1));
    }
  }
  const last = Math.max(...depth.values());
  for (const name of byName.keys()) {
    if (!depth.has(name)) {
      depth.set(name, last + 1);
      order.push(name);
    }
  }
  const layers = new Map();
  for (const name of order) {
    const layer = layers.get(depth.get(name)) || [];
    layer.push(name);
    layers.set(depth.get(name), layer);
  }
  for (const [row, names] of layers) {
    names.forEach((name, index) => {
      const element = byName.get(name);
      element.locationX =
        600 + Math.round((index - (names.length - 1) / 2) * 260);
      element.locationY = row * 160;
    });
  }
}

function flow(fields, start, elements, resources) {
  const first = start.connector.targetReference;
  layout(elements, first);
  const metadata = {
    apiVersion: 62,
    status: "Draft",
    processMetadataValues: FREE_FORM,
    ...fields,
    start: { locationX: 600, locationY: 0, ...start }
  };
  for (const [type, element] of elements) {
    (metadata[type] = metadata[type] || []).push({
      label: label(element.name),
      ...element
    });
  }
  return JSON.parse(JSON.stringify({ ...metadata, ...resources }));
}

// ---- The discount flows, three ways ------------------------------------

const PRICING =
  "Order pricing: region rates, tier bonuses, volume discounts, promo line items and approval.";
const DESCRIPTIONS = {
  base: PRICING,
  ours: `${PRICING} Adds a loyalty bonus.`,
  theirs: `${PRICING} Holds risky orders for review.`
};

function pricing(letter, variant, title = `UAT Discounts ${letter}`) {
  const ours = variant === "ours";
  const theirs = variant === "theirs";
  const nudge = "ABCDEF".indexOf(letter);
  const afterBonus = ours ? "Check_Loyalty" : "Check_Amount";
  const elements = [
    decide(
      "Validate_Input",
      [["Missing_Amount", [["amount", "IsNull", true]], "Set_Error"]],
      theirs ? "Score_Risk" : "Get_Pricebook",
      "Valid"
    ),
    assign("Set_Error", [["errorMessage", "Assign", "An amount is required."]]),
    lookup(
      "Get_Pricebook",
      "Pricebook2",
      [["IsStandard", "EqualTo", true]],
      "Check_Region",
      "Log_Error"
    ),
    assign("Log_Error", [
      ["errorMessage", "Assign", ref("$Flow.FaultMessage")]
    ]),
    decide(
      "Check_Region",
      [
        ["North_America", [["region", "EqualTo", "NA"]], "Set_NA_Rate"],
        ["EMEA", [["region", "EqualTo", "EMEA"]], "Set_EMEA_Rate"],
        ["APAC", [["region", "EqualTo", "APAC"]], "Set_APAC_Rate"]
      ],
      "Set_Default_Rate"
    ),
    assign("Set_NA_Rate", [["rate", "Assign", 5 + nudge]], "Check_Tier"),
    assign("Set_EMEA_Rate", [["rate", "Assign", 4 + nudge]], "Check_Tier"),
    assign("Set_APAC_Rate", [["rate", "Assign", 6]], "Check_Tier"),
    assign("Set_Default_Rate", [["rate", "Assign", 2]], "Check_Tier"),
    decide(
      "Check_Tier",
      [
        ["Gold", [["tier", "EqualTo", "Gold"]], "Gold_Bonus"],
        ["Silver", [["tier", "EqualTo", "Silver"]], "Silver_Bonus"],
        ...(theirs
          ? [["Platinum", [["tier", "EqualTo", "Platinum"]], "Platinum_Bonus"]]
          : [])
      ],
      afterBonus
    ),
    assign("Gold_Bonus", [["bonus", "Assign", 5]], afterBonus),
    assign("Silver_Bonus", [["bonus", "Assign", 3]], afterBonus),
    ...(theirs
      ? [assign("Platinum_Bonus", [["bonus", "Assign", 8]], "Check_Amount")]
      : []),
    ...(ours
      ? [
          decide(
            "Check_Loyalty",
            [
              [
                "Long_Standing",
                [["loyaltyYears", "GreaterThanOrEqualTo", 5]],
                "Loyalty_Bonus"
              ]
            ],
            "Check_Amount"
          ),
          assign("Loyalty_Bonus", [["bonus", "Add", 2]], "Loyalty_Note"),
          assign(
            "Loyalty_Note",
            [["loyaltyNote", "Assign", "Loyal for {!loyaltyYears} years"]],
            "Check_Amount"
          )
        ]
      : []),
    decide(
      "Check_Amount",
      [
        [
          "Large",
          [["amount", "GreaterThanOrEqualTo", ours ? 8000 : 10000]],
          "Set_Large_Discount"
        ],
        [
          "Medium",
          [["amount", "GreaterThanOrEqualTo", 1000]],
          "Set_Medium_Discount"
        ]
      ],
      "Set_Standard_Discount"
    ),
    assign(
      "Set_Large_Discount",
      [
        ["discount", "Assign", ref("rate")],
        ["discount", "Add", ref("bonus")],
        ["discount", "Add", ours ? 12 : theirs ? 15 : 10]
      ],
      "Apply_Cap"
    ),
    assign(
      "Set_Medium_Discount",
      [
        ["discount", "Assign", ref("rate")],
        ["discount", "Add", ref("bonus")],
        ["discount", "Add", 5]
      ],
      "Apply_Cap"
    ),
    assign(
      "Set_Standard_Discount",
      [
        ["discount", "Assign", ref("rate")],
        ["discount", "Add", ref("bonus")]
      ],
      "Apply_Cap"
    ),
    decide(
      "Apply_Cap",
      [
        [
          "Over_Cap",
          [["discount", "GreaterThan", ref("MAX_DISCOUNT")]],
          "Cap_Discount"
        ]
      ],
      "Loop_Items"
    ),
    assign(
      "Cap_Discount",
      [["discount", "Assign", ref("MAX_DISCOUNT")]],
      "Loop_Items"
    ),
    loop(
      "Loop_Items",
      "lineItems",
      "currentItem",
      "Count_Item",
      "Check_Approval"
    ),
    assign("Count_Item", [["itemCount", "Add", 1]], "Check_Item"),
    decide(
      "Check_Item",
      [["Promo", [["currentItem", "StartsWith", "PROMO"]], "Add_Promo"]],
      "Loop_Items"
    ),
    assign(
      "Add_Promo",
      [
        ["promoCount", "Add", 1],
        ["discount", "Add", theirs ? 2 : 1]
      ],
      "Loop_Items"
    ),
    decide(
      "Check_Approval",
      [
        [
          "Needs_Approval",
          [
            ["discount", "GreaterThan", 20],
            ["amount", "GreaterThan", 50000]
          ],
          "Set_Needs_Approval",
          "or"
        ]
      ],
      "Build_Summary"
    ),
    assign(
      "Set_Needs_Approval",
      [["needsApproval", "Assign", true]],
      "Find_Approver"
    ),
    lookup(
      "Find_Approver",
      "User",
      [["IsActive", "EqualTo", true]],
      "Set_Approver",
      "Log_Error"
    ),
    assign(
      "Set_Approver",
      [["approverId", "Assign", ref("Find_Approver.Id")]],
      "Build_Summary"
    ),
    assign(
      "Build_Summary",
      [
        ["summary", "Assign", ref("summaryText")],
        ...(theirs ? [["summary", "Add", " Risk checked."]] : [])
      ],
      ours ? "Set_Net" : "Round_Discount"
    ),
    ...(ours
      ? []
      : [
          assign(
            "Round_Discount",
            [["discount", "Assign", ref("roundedDiscount")]],
            "Set_Net"
          )
        ]),
    assign("Set_Net", [["netTotal", "Assign", ref("netAmount")]]),
    ...(theirs
      ? [
          assign(
            "Score_Risk",
            [["riskScore", "Assign", ref("riskEstimate")]],
            "Check_Risk"
          ),
          decide(
            "Check_Risk",
            [["High_Risk", [["riskScore", "GreaterThan", 50]], "Hold_Order"]],
            "Get_Pricebook"
          ),
          assign(
            "Hold_Order",
            [
              ["holdReason", "Assign", "Risk score is over 50"],
              ["needsApproval", "Assign", true]
            ],
            "Notify_Risk_Team"
          ),
          assign("Notify_Risk_Team", [
            ["summary", "Assign", "Held for review: {!holdReason}"]
          ])
        ]
      : [])
  ];
  const variables = [
    variable("amount", "Currency", IN),
    variable("region", "String", IN),
    variable("tier", "String", IN),
    variable("lineItems", "String", { ...IN, isCollection: true }),
    ...(ours ? [variable("loyaltyYears", "Number", IN)] : []),
    variable("rate", "Number"),
    variable("bonus", "Number"),
    variable("discount", "Number", OUT),
    variable("needsApproval", "Boolean", OUT),
    variable("approverId", "String", OUT),
    variable("summary", "String", OUT),
    variable("errorMessage", "String", OUT),
    variable("netTotal", "Currency", OUT),
    variable("itemCount", "Number"),
    variable("promoCount", "Number"),
    variable("currentItem", "String"),
    ...(ours ? [variable("loyaltyNote", "String")] : []),
    ...(theirs
      ? [variable("riskScore", "Number"), variable("holdReason", "String", OUT)]
      : [])
  ];
  const formulas = [
    {
      name: "netAmount",
      dataType: "Currency",
      scale: 2,
      expression: "{!amount} * (1 - {!discount} / 100)"
    },
    ...(ours
      ? []
      : [
          {
            name: "roundedDiscount",
            dataType: "Number",
            scale: 0,
            expression: "ROUND({!discount}, 0)"
          }
        ]),
    ...(theirs
      ? [
          {
            name: "riskEstimate",
            dataType: "Number",
            scale: 0,
            expression: "{!amount} / 1000 + IF({!region} = 'APAC', 10, 0)"
          }
        ]
      : [])
  ];
  return flow(
    {
      label: title,
      description: DESCRIPTIONS[variant],
      processType: "AutoLaunchedFlow",
      interviewLabel: `${title} {!$Flow.CurrentDateTime}`
    },
    { connector: to("Validate_Input") },
    elements,
    {
      variables,
      constants: [
        {
          name: "MAX_DISCOUNT",
          dataType: "Number",
          value: { numberValue: theirs ? 35 : 30 }
        }
      ],
      formulas,
      textTemplates: [
        {
          name: "summaryText",
          isViewedAsPlainText: true,
          text: ours
            ? "Region {!region}, tier {!tier}: {!discount}% off {!itemCount} items ({!promoCount} promo). {!loyaltyNote}"
            : "Region {!region}, tier {!tier}: {!discount}% off {!itemCount} items ({!promoCount} promo)."
        }
      ]
    }
  );
}

// ---- Case flows that do related work from different starts --------------

function caseRecordTriggered() {
  return flow(
    {
      label: "UAT Case Triage Record",
      description:
        "Triage a case when it's created or changed: SLA by priority, key accounts, a follow-up task and origin tags.",
      processType: "AutoLaunchedFlow",
      interviewLabel: "UAT Case Triage Record {!$Flow.CurrentDateTime}"
    },
    {
      object: "Case",
      recordTriggerType: "CreateAndUpdate",
      triggerType: "RecordAfterSave",
      connector: to("Check_Status")
    },
    [
      decide(
        "Check_Status",
        [["Closed", [["$Record.IsClosed", "EqualTo", true]]]],
        "Get_Account",
        "Open"
      ),
      lookup(
        "Get_Account",
        "Account",
        [["Id", "EqualTo", ref("$Record.AccountId")]],
        "Check_Priority",
        "Log_Fault"
      ),
      assign("Log_Fault", [["faultText", "Assign", ref("$Flow.FaultMessage")]]),
      decide(
        "Check_Priority",
        [
          ["High", [["$Record.Priority", "EqualTo", "High"]], "Escalate"],
          [
            "Medium",
            [["$Record.Priority", "EqualTo", "Medium"]],
            "Set_Medium_SLA"
          ]
        ],
        "Set_Low_SLA"
      ),
      update(
        "Escalate",
        "$Record",
        [["IsEscalated", true]],
        "Set_High_SLA",
        "Log_Fault"
      ),
      assign("Set_High_SLA", [["slaHours", "Assign", 4]], "Check_Account_Tier"),
      assign(
        "Set_Medium_SLA",
        [["slaHours", "Assign", 24]],
        "Check_Account_Tier"
      ),
      assign("Set_Low_SLA", [["slaHours", "Assign", 72]], "Check_Account_Tier"),
      decide(
        "Check_Account_Tier",
        [
          [
            "Key_Account",
            [["Get_Account.Rating", "EqualTo", "Hot"]],
            "Shorten_SLA"
          ]
        ],
        "Create_Follow_Up"
      ),
      assign("Shorten_SLA", [["slaHours", "Subtract", 2]], "Create_Follow_Up"),
      create(
        "Create_Follow_Up",
        "Task",
        [
          ["Subject", ref("followUpSubject")],
          ["WhatId", ref("$Record.Id")],
          ["Priority", ref("$Record.Priority")]
        ],
        "Check_Origin",
        "Log_Fault"
      ),
      decide("Check_Origin", [
        ["Web", [["$Record.Origin", "EqualTo", "Web"]], "Tag_Web"],
        ["Email", [["$Record.Origin", "EqualTo", "Email"]], "Tag_Email"]
      ]),
      assign("Tag_Web", [["originNote", "Assign", "Came in on the web"]]),
      assign("Tag_Email", [["originNote", "Assign", "Came in by email"]])
    ],
    {
      variables: [
        variable("slaHours", "Number"),
        variable("faultText", "String"),
        variable("originNote", "String")
      ],
      textTemplates: [
        {
          name: "followUpSubject",
          isViewedAsPlainText: true,
          text: "Follow up on {!$Record.CaseNumber}: {!$Record.Subject}"
        }
      ]
    }
  );
}

function caseSubflow() {
  return flow(
    {
      label: "UAT Case Triage Sub",
      description:
        "Escalate a case passed in, email its contact and count the account's open cases.",
      processType: "AutoLaunchedFlow",
      interviewLabel: "UAT Case Triage Sub {!$Flow.CurrentDateTime}"
    },
    { connector: to("Check_Priority") },
    [
      decide(
        "Check_Priority",
        [["High", [["caseRecord.Priority", "EqualTo", "High"]], "Escalate"]],
        "Check_SLA"
      ),
      update(
        "Escalate",
        { object: "Case", filters: [["Id", "EqualTo", ref("caseRecord.Id")]] },
        [
          ["IsEscalated", true],
          ["Priority", "High"]
        ],
        "Check_SLA",
        "Handle_Error"
      ),
      decide(
        "Check_SLA",
        [
          [
            "Escalated",
            [["caseRecord.IsEscalated", "EqualTo", true]],
            "Notify_Manager"
          ]
        ],
        "Get_Contact"
      ),
      assign(
        "Notify_Manager",
        [
          [
            "managerNote",
            "Assign",
            "Case {!caseRecord.CaseNumber} was escalated"
          ]
        ],
        "Get_Contact"
      ),
      lookup(
        "Get_Contact",
        "Contact",
        [["Id", "EqualTo", ref("caseRecord.ContactId")]],
        "Check_Contact",
        "Handle_Error"
      ),
      decide(
        "Check_Contact",
        [
          ["Has_Email", [["Get_Contact.Email", "IsNull", false]], "Build_Email"]
        ],
        "Update_Case"
      ),
      assign(
        "Build_Email",
        [["emailBody", "Assign", ref("emailText")]],
        "Update_Case"
      ),
      update(
        "Update_Case",
        { object: "Case", filters: [["Id", "EqualTo", ref("caseRecord.Id")]] },
        [["Description", ref("managerNote")]],
        "Get_Open_Cases",
        "Handle_Error"
      ),
      lookup(
        "Get_Open_Cases",
        "Case",
        [
          ["AccountId", "EqualTo", ref("caseRecord.AccountId")],
          ["IsClosed", "EqualTo", false]
        ],
        "Loop_Cases",
        "Handle_Error",
        true
      ),
      loop(
        "Loop_Cases",
        "Get_Open_Cases",
        "currentCase",
        "Count_Case",
        "Log_Done"
      ),
      assign("Count_Case", [["openCount", "Add", 1]], "Loop_Cases"),
      assign("Log_Done", [
        ["resultText", "Assign", "{!openCount} open cases on the account"]
      ]),
      assign("Handle_Error", [
        ["errorText", "Assign", ref("$Flow.FaultMessage")]
      ])
    ],
    {
      variables: [
        variable("caseRecord", "SObject", { ...IN, objectType: "Case" }),
        variable("currentCase", "SObject", { objectType: "Case" }),
        variable("managerNote", "String"),
        variable("emailBody", "String"),
        variable("openCount", "Number", OUT),
        variable("resultText", "String", OUT),
        variable("errorText", "String", OUT)
      ],
      textTemplates: [
        {
          name: "emailText",
          isViewedAsPlainText: true,
          text: "Hi {!Get_Contact.FirstName}, case {!caseRecord.CaseNumber} ({!caseRecord.Subject}) is being looked at."
        }
      ]
    }
  );
}

function caseScreen() {
  return flow(
    {
      label: "UAT Case Screen",
      description: "Look at a case from its page, escalate it and save notes.",
      processType: "Flow",
      interviewLabel: "UAT Case Screen {!$Flow.CurrentDateTime}"
    },
    { connector: to("Get_Case") },
    [
      lookup(
        "Get_Case",
        "Case",
        [["Id", "EqualTo", ref("recordId")]],
        "Show_Case",
        "Show_Error"
      ),
      screen(
        "Show_Case",
        [
          text(
            "Case_Info",
            "<p>Case {!Get_Case.CaseNumber}: {!Get_Case.Subject}</p>"
          ),
          input("Notes", "Notes")
        ],
        "Check_Priority"
      ),
      decide(
        "Check_Priority",
        [
          [
            "High",
            [["Get_Case.Priority", "EqualTo", "High"]],
            "Confirm_Escalation"
          ]
        ],
        "Save_Notes"
      ),
      screen(
        "Confirm_Escalation",
        [
          text(
            "Escalation_Info",
            "<p>This case is high priority and will be escalated.</p>"
          )
        ],
        "Escalate"
      ),
      update(
        "Escalate",
        { object: "Case", filters: [["Id", "EqualTo", ref("Get_Case.Id")]] },
        [["IsEscalated", true]],
        "Save_Notes",
        "Show_Error"
      ),
      update(
        "Save_Notes",
        { object: "Case", filters: [["Id", "EqualTo", ref("recordId")]] },
        [["Comments", ref("Notes")]],
        "Done",
        "Show_Error"
      ),
      screen("Done", [text("Done_Info", "<p>Saved.</p>")]),
      screen("Show_Error", [text("Error_Info", "<p>{!$Flow.FaultMessage}</p>")])
    ],
    { variables: [variable("recordId", "String", IN)] }
  );
}

// Each flow's versions, oldest first.
const FLOWS = [
  ..."ABCDEF".split("").map((letter) => ({
    name: `UAT_Discounts_${letter}`,
    versions: ["base", "ours", "theirs"].map((variant) =>
      pricing(letter, variant)
    )
  })),
  // Synthetic flows for the help videos (record-help.js). Nothing triggers
  // them, so they're safe to activate.
  {
    name: "Order_Discounts",
    versions: ["base", "ours", "theirs"].map((variant) =>
      pricing("A", variant, "Order Discounts")
    )
  },
  {
    name: "Partner_Discounts",
    versions: [pricing("B", "ours", "Partner Discounts")]
  },
  { name: "UAT_Case_Triage_Record", versions: [caseRecordTriggered()] },
  { name: "UAT_Case_Triage_Sub", versions: [caseSubflow()] },
  { name: "UAT_Case_Screen", versions: [caseScreen()] }
];

// ---- Talking to the org -------------------------------------------------

function sf(cliArgs) {
  const out = execFileSync(
    "sf",
    [...cliArgs, "--target-org", ALIAS, "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  return JSON.parse(out.slice(out.indexOf("{"))).result;
}

let token;
async function rest(route, init = {}) {
  token = token || sf(["org", "auth", "show-access-token"]).accessToken;
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `${route.split("?")[0]} answered ${response.status}: ${body}`
    );
  }
  return body ? JSON.parse(body) : undefined;
}

const ELEMENTS = [
  "assignments",
  "decisions",
  "loops",
  "recordCreates",
  "recordLookups",
  "recordUpdates",
  "screens"
];
const size = (metadata) =>
  ELEMENTS.reduce((sum, type) => sum + (metadata[type] || []).length, 0);

const query = (soql) =>
  rest(`/tooling/query?q=${encodeURIComponent(soql)}`).then((r) => r.records);

// The versions already there, as descriptions, so a rerun adds only what's missing.
const existing = (name) =>
  query(
    `SELECT VersionNumber, Description FROM Flow WHERE Definition.DeveloperName = '${name}' ORDER BY VersionNumber`
  );

async function main() {
  let failed = 0;
  for (const { name, versions } of FLOWS) {
    if (DUMP) {
      versions.forEach((metadata, index) => {
        const dir = path.join(DUMP, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `v${index + 1}.json`),
          `${JSON.stringify({ FullName: name, Metadata: metadata }, null, 2)}\n`
        );
      });
    }
    const there = await existing(name);
    // A seeded run is the whole series in a row; start over after the last one there.
    const last = there
      .map((record) => record.Description)
      .lastIndexOf(versions[0].description);
    const done =
      last === -1
        ? 0
        : versions.findIndex(
            (metadata, index) =>
              !there[last + index] ||
              there[last + index].Description !== metadata.description
          );
    const todo = done === -1 ? [] : versions.slice(done);
    if (!todo.length) {
      console.log(`${name}: already seeded`);
      continue;
    }
    for (const metadata of todo) {
      if (DRY) {
        console.log(
          `${name}: would add a version with ${size(metadata)} elements`
        );
        continue;
      }
      try {
        await rest("/tooling/sobjects/Flow", {
          method: "POST",
          // A new flow is named plainly; later versions by the namespaced name and
          // their number.
          body: JSON.stringify({
            FullName: there.length
              ? `${NS}${name}-${Math.max(...there.map((r) => r.VersionNumber)) + 1}`
              : name,
            Metadata: metadata
          })
        });
        there.push(...(await existing(name)).slice(there.length));
        console.log(
          `${name}: added version ${there.at(-1).VersionNumber} (${size(metadata)} elements)`
        );
      } catch (error) {
        failed += 1;
        console.log(`${name}: ${error.message}`);
        break;
      }
    }
  }
  if (failed) {
    console.log(`${failed} flow(s) failed`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.log(error.message);
  process.exit(1);
});
