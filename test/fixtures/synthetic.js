/**
 * Small synthetic flows for tests: made up here, not taken from any org.
 */

// An assignment that adds 1 to Count.
const step = (name, label, y, extra = {}) => ({
  name,
  label,
  locationX: 0,
  locationY: y,
  assignmentItems: [
    {
      assignToReference: "Count",
      operator: "Add",
      value: { numberValue: 1 }
    }
  ],
  ...extra
});

// A start element and assignments A and B, wired Start → A → B.
const small = () => ({
  label: "Small",
  processType: "AutoLaunchedFlow",
  start: { locationX: 0, locationY: 0, connector: { targetReference: "A" } },
  assignments: [
    step("A", "A", 100, { connector: { targetReference: "B" } }),
    step("B", "B", 200)
  ],
  variables: [
    { name: "Count", dataType: "Number", scale: 0, isCollection: false }
  ]
});

// small() with X1 → X2 put between A and B, and Y1 → Y2 on their own.
const grown = () => {
  const flow = small();
  flow.assignments[0].connector.targetReference = "X1";
  flow.assignments.push(
    step("X1", "X1", 300, { connector: { targetReference: "X2" } }),
    step("X2", "X2", 400, { connector: { targetReference: "B" } }),
    step("Y1", "Y1", 500, { connector: { targetReference: "Y2" } }),
    step("Y2", "Y2", 600)
  );
  return flow;
};
// small() with more on its own: a decision D whose Yes path saves (P1,
// whose fault path goes to H) and ends at P2, and whose other path goes
// Q1 → B; a Loop L round LB; R, which leads back to A; and E1 and E2,
// which both lead into M.
const branchy = () => {
  const flow = small();
  const to = (target) => ({ connector: { targetReference: target } });
  flow.decisions = [
    {
      name: "D",
      label: "D",
      locationX: 0,
      locationY: 700,
      rules: [
        {
          name: "Yes",
          label: "Yes",
          conditionLogic: "and",
          conditions: [
            {
              leftValueReference: "Count",
              operator: "EqualTo",
              rightValue: { numberValue: 1 }
            }
          ],
          ...to("P1")
        }
      ],
      defaultConnectorLabel: "Otherwise",
      defaultConnector: { targetReference: "Q1" }
    }
  ];
  flow.recordUpdates = [
    {
      name: "P1",
      label: "P1",
      locationX: 0,
      locationY: 800,
      inputReference: "Rec",
      ...to("P2"),
      faultConnector: { targetReference: "H" }
    }
  ];
  flow.loops = [
    {
      name: "L",
      label: "L",
      locationX: 0,
      locationY: 900,
      collectionReference: "Items",
      iterationOrder: "Asc",
      nextValueConnector: { targetReference: "LB" }
    }
  ];
  flow.assignments.push(
    step("P2", "P2", 1000),
    step("H", "H", 1100),
    step("Q1", "Q1", 1200, to("B")),
    step("LB", "LB", 1300, to("L")),
    step("R", "R", 1400, to("A")),
    step("E1", "E1", 1500, to("M")),
    step("E2", "E2", 1600, to("M")),
    step("M", "M", 1700)
  );
  flow.variables.push(
    {
      name: "Rec",
      dataType: "SObject",
      objectType: "Account",
      isCollection: false
    },
    { name: "Items", dataType: "String", isCollection: true }
  );
  return flow;
};

const pad = (number) => String(number).padStart(4, "0");

// A synthetic flow of at least `size` elements, of blocks one after
// another: a step; a decision whose three outcomes meet again; a Loop with
// a step inside; and an update whose fault path has its own handler. The
// same size always gives the same flow.
const large = (size) => {
  const flow = {
    label: `Large ${size}`,
    processType: "AutoLaunchedFlow",
    processMetadataValues: [
      { name: "CanvasMode", value: { stringValue: "FREE_FORM_CANVAS" } }
    ],
    start: { locationX: 0, locationY: 0 },
    assignments: [],
    decisions: [],
    loops: [],
    recordUpdates: [],
    variables: [
      { name: "Count", dataType: "Number", scale: 0, isCollection: false },
      { name: "Items", dataType: "String", isCollection: true },
      {
        name: "Rec",
        dataType: "SObject",
        objectType: "Account",
        isCollection: false
      }
    ]
  };
  const values = Math.max(1, Math.floor(size / 10));
  for (let index = 0; index < values; index++) {
    flow.variables.push({
      name: `V${pad(index)}`,
      dataType: "Number",
      scale: 0,
      isCollection: false
    });
  }
  const at = (name, x, y, extra = {}) => ({
    name,
    label: name,
    locationX: x,
    locationY: y,
    ...extra
  });
  const assign = (name, x, y, index, extra) =>
    at(name, x, y, {
      assignmentItems: [
        {
          assignToReference: `V${pad(index % values)}`,
          operator: "Add",
          value: { numberValue: 1 }
        }
      ],
      ...extra
    });
  const to = (target) => ({ targetReference: target });
  // Each block: its first element, and a way to point its ends onward.
  const blocks = [];
  let count = 0;
  let y = 150;
  for (let index = 0; count < size; index++) {
    const id = pad(index);
    const kind = index % 4;
    if (kind === 0) {
      const element = assign(`S${id}`, 0, y, index);
      flow.assignments.push(element);
      blocks.push({ entry: element.name, ends: [element] });
      count += 1;
      y += 150;
    } else if (kind === 1) {
      const join = assign(`J${id}`, 0, y + 300, index);
      const arms = ["a", "b", "c"].map((arm, place) =>
        assign(`D${id}${arm}`, (place - 1) * 250, y + 150, index, {
          connector: to(join.name)
        })
      );
      flow.decisions.push(
        at(`D${id}`, 0, y, {
          rules: ["One", "Two"].map((rule, which) => ({
            name: `D${id}_${rule}`,
            label: rule,
            conditionLogic: "and",
            conditions: [
              {
                leftValueReference: `V${pad(index % values)}`,
                operator: "GreaterThan",
                rightValue: { numberValue: which + 1 }
              }
            ],
            connector: to(arms[which].name)
          })),
          defaultConnectorLabel: "Otherwise",
          defaultConnector: to(arms[2].name)
        })
      );
      flow.assignments.push(...arms, join);
      blocks.push({ entry: `D${id}`, ends: [join] });
      count += 5;
      y += 450;
    } else if (kind === 2) {
      const body = assign(`L${id}b`, 250, y + 150, index, {
        connector: to(`L${id}`)
      });
      const loop = at(`L${id}`, 0, y, {
        collectionReference: "Items",
        iterationOrder: "Asc",
        nextValueConnector: to(body.name)
      });
      flow.loops.push(loop);
      flow.assignments.push(body);
      blocks.push({
        entry: loop.name,
        ends: [loop],
        slot: "noMoreValuesConnector"
      });
      count += 2;
      y += 300;
    } else {
      const handler = assign(`U${id}h`, 250, y + 150, index);
      const update = at(`U${id}`, 0, y, {
        inputReference: "Rec",
        faultConnector: to(handler.name)
      });
      flow.recordUpdates.push(update);
      flow.assignments.push(handler);
      blocks.push({ entry: update.name, ends: [update, handler] });
      count += 2;
      y += 300;
    }
  }
  flow.start.connector = to(blocks[0].entry);
  for (let index = 0; index + 1 < blocks.length; index++) {
    const block = blocks[index];
    for (const end of block.ends) {
      end[block.slot || "connector"] = to(blocks[index + 1].entry);
    }
  }
  return flow;
};

// A copy of a flow with some of its steps changed: each `every`th
// assignment from `offset` adds 2 instead of 1 and says so in its label.
// `move` shifts every element sideways, which changes nothing it does.
const revise = (flow, { every = 10, offset = 0, move = 0 } = {}) => {
  const copy = JSON.parse(JSON.stringify(flow));
  copy.assignments.forEach((element, index) => {
    if (index % every === offset) {
      element.label = `${element.label} (revised)`;
      element.assignmentItems[0].value = { numberValue: 2 };
    }
  });
  if (move) {
    for (const field of [
      "assignments",
      "decisions",
      "loops",
      "recordUpdates"
    ]) {
      for (const element of copy[field]) {
        element.locationX += move;
      }
    }
  }
  return copy;
};

module.exports = { step, small, grown, branchy, large, revise };
