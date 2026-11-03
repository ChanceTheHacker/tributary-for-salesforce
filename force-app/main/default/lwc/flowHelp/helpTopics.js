// Written by test/e2e/record-help.js from test/e2e/help-scenes.js. Captions
// can be corrected here; recording a topic again rewrites its entry.
// at: seconds into the video where each step starts.
import compareVideo from "@salesforce/resourceUrl/Help_Compare";
import compareOtherVideo from "@salesforce/resourceUrl/Help_CompareOther";
import viewsVideo from "@salesforce/resourceUrl/Help_Views";
import mergeVideo from "@salesforce/resourceUrl/Help_Merge";
import saveVideo from "@salesforce/resourceUrl/Help_Save";
import activateVideo from "@salesforce/resourceUrl/Help_Activate";
import governVideo from "@salesforce/resourceUrl/Help_Govern";
import requestVideo from "@salesforce/resourceUrl/Help_Request";
import approveVideo from "@salesforce/resourceUrl/Help_Approve";
import historyVideo from "@salesforce/resourceUrl/Help_History";

const TOPICS = {
  compare: {
    title: "Compare two versions of a flow",
    action: "compare two versions of a flow",
    duration: 18.6,
    steps: [
      {
        at: 0.3,
        text: "Choose the flow you want to compare."
      },
      {
        at: 6.7,
        text: "Tributary picks two versions for you. Change either one here."
      },
      {
        at: 10.5,
        text: "Colours show what was added, removed or changed."
      },
      {
        at: 14.1,
        text: "Click any element to see exactly what changed in it."
      }
    ],
    video: compareVideo
  },
  "compare-other": {
    title: "Compare two flows, or two orgs",
    action: "compare two different flows, or a flow in two orgs",
    duration: 17.5,
    steps: [
      {
        at: 0.3,
        text: "Choose Two flows to put different flows side by side."
      },
      {
        at: 3.9,
        text: "Pick the second flow."
      },
      {
        at: 9.8,
        text: "Their differences are shown just as for two versions."
      },
      {
        at: 12.7,
        text: "Two orgs compares a flow with its copy in another org, such as a sandbox."
      }
    ],
    video: compareOtherVideo
  },
  views: {
    title: "Read the differences",
    action: "read the differences in each view",
    duration: 20.4,
    steps: [
      {
        at: 0.3,
        text: "Side by side puts version A on the left and B on the right."
      },
      {
        at: 3.5,
        text: "Step through the changes one at a time with the arrows."
      },
      {
        at: 8,
        text: "Combined shows one canvas with every change marked."
      },
      {
        at: 11.9,
        text: "Fade unchanged dims everything that stayed the same."
      },
      {
        at: 15.3,
        text: "XML shows the flow's file, line by line."
      }
    ],
    video: viewsVideo
  },
  merge: {
    title: "Merge two versions",
    action: "merge two versions into one",
    duration: 21.3,
    steps: [
      {
        at: 0.3,
        text: "Merge builds one flow from two versions. With a common base, it knows who changed what."
      },
      {
        at: 4.9,
        text: "A conflict is something both versions changed. Click one to decide."
      },
      {
        at: 8.6,
        text: "Choose which version to keep."
      },
      {
        at: 12.3,
        text: "Or take one side for everything with a preset."
      },
      {
        at: 17,
        text: "Changed your mind? Undo, or press Ctrl+Z."
      }
    ],
    video: mergeVideo
  },
  save: {
    title: "Save a merged flow",
    action: "save a merged flow",
    duration: 14.2,
    steps: [
      {
        at: 0.3,
        text: "Once every conflict is settled, save the result."
      },
      {
        at: 4,
        text: "It's saved as a new version of the flow. Nothing is activated."
      },
      {
        at: 7.4,
        text: "Save."
      },
      {
        at: 9.8,
        text: "The new version is ready to test, compare or activate."
      }
    ],
    video: saveVideo
  },
  activate: {
    title: "Activate a version",
    action: "activate a version",
    duration: 12.8,
    steps: [
      {
        at: 0.3,
        text: "Activate shows which version is live and lets you switch."
      },
      {
        at: 3.5,
        text: "Click Activate on the version you want live."
      },
      {
        at: 6.5,
        text: "Confirm."
      },
      {
        at: 8.8,
        text: "Version 3 is live, and the change is recorded."
      }
    ],
    video: activateVideo
  },
  govern: {
    title: "Govern a flow",
    action: "put a flow under governance",
    duration: 18.8,
    steps: [
      {
        at: 0.3,
        text: "Governing a flow gives it an owner, who decides what gets activated."
      },
      {
        at: 4,
        text: "Choose the flow."
      },
      {
        at: 8.1,
        text: "The owner approves requests to activate it."
      },
      {
        at: 11.3,
        text: "Approval required means every activation needs the owner's approval."
      },
      {
        at: 15,
        text: "Save. The flow is now governed."
      }
    ],
    video: governVideo
  },
  request: {
    title: "Ask for a version to be activated",
    action: "ask a flow's owner to activate a version",
    duration: 14.7,
    steps: [
      {
        at: 0.3,
        text: "A governed flow is activated by its owner. You ask them."
      },
      {
        at: 3.6,
        text: "Say what the version changes."
      },
      {
        at: 8.6,
        text: "Send the request."
      },
      {
        at: 10.6,
        text: "The owner is told. Follow it on Flow Approvals."
      }
    ],
    video: requestVideo
  },
  approve: {
    title: "Approve a request",
    action: "approve or reject a request",
    duration: 16.1,
    steps: [
      {
        at: 0.3,
        text: "Flow Approvals lists the requests waiting for you."
      },
      {
        at: 3.4,
        text: "Compare shows what the version would change."
      },
      {
        at: 6.7,
        text: "Approve it, with a note if you like. Reject works the same way."
      },
      {
        at: 12.3,
        text: "Confirm. The version is activated for the requester."
      }
    ],
    video: approveVideo
  },
  history: {
    title: "See a flow's history",
    action: "see a governed flow's history",
    duration: 12.3,
    steps: [
      {
        at: 0.3,
        text: "Governed Flows lists each flow with its owner, mode and live version."
      },
      {
        at: 3.5,
        text: "History shows every request, approval and activation."
      },
      {
        at: 8.1,
        text: "Run check now puts back anything activated outside the rules."
      }
    ],
    video: historyVideo
  }
};

export default TOPICS;
