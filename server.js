import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
  Prototype storage.

  This works on one continuously running server. For production, replace this
  Map and its timers with Redis plus a durable job queue.
*/
const calls = new Map();

const HOLD_PHRASES = [
  "hold on",
  "hang on",
  "wait",
  "give me a second",
  "give me a minute",
  "one moment",
  "just a second",
  "let me check",
  "let me look",
  "be right back"
];

function containsHoldPhrase(text = "") {
  const normalized = text.toLowerCase().trim();
  return HOLD_PHRASES.some((phrase) => normalized.includes(phrase));
}

function getCallState(callId) {
  if (!calls.has(callId)) {
    calls.set(callId, {
      controlUrl: null,
      holdUntil: 0,
      generation: 0,
      checkTimer: null,
      endTimer: null,
      injectedCheckIn: false
    });
  }

  return calls.get(callId);
}

function clearTimers(state) {
  if (state.checkTimer) clearTimeout(state.checkTimer);
  if (state.endTimer) clearTimeout(state.endTimer);

  state.checkTimer = null;
  state.endTimer = null;
}

async function sendControl(controlUrl, body) {
  if (!controlUrl) return;

  const response = await fetch(controlUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"

      /*
        If you later enable controlAuthenticationEnabled, add:

        authorization: `Bearer ${process.env.VAPI_PUBLIC_API_KEY}`
      */
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(
      `Vapi control request failed: ${response.status} ${responseText}`
    );
  }
}

async function politelyEndCall(state, message) {
  await sendControl(state.controlUrl, {
    type: "say",
    content: message,
    endCallAfterSpoken: true
  });
}

function scheduleNormalSilenceCheck(callId) {
  const state = getCallState(callId);

  clearTimers(state);
  const generation = ++state.generation;

  state.checkTimer = setTimeout(async () => {
    if (state.generation !== generation) return;

    /*
      The caller asked Alex to wait. Suppress the seven-second check-in and
      allow the remainder of the two-minute hold period.
    */
    if (state.holdUntil > Date.now()) {
      const remaining = state.holdUntil - Date.now();

      state.endTimer = setTimeout(async () => {
        if (state.generation !== generation) return;

        try {
          await politelyEndCall(
            state,
            "I haven't heard back, so I'll end the call for now. Please call us again whenever you're ready."
          );
        } catch (error) {
          console.error(error);
        }
      }, remaining);

      return;
    }

    try {
      state.injectedCheckIn = true;

      await sendControl(state.controlUrl, {
        type: "say",
        content: "Are you still there?",
        endCallAfterSpoken: false
      });

      /*
        The first seven seconds have elapsed. Allow another 23 seconds before
        ending, producing 30 seconds of total caller silence.
      */
      state.endTimer = setTimeout(async () => {
        if (state.generation !== generation) return;

        try {
          await politelyEndCall(
            state,
            "I haven't heard a response, so I'll end the call now. Please feel free to call us back."
          );
        } catch (error) {
          console.error(error);
        }
      }, 23_000);
    } catch (error) {
      console.error(error);
    }
  }, 7_000);
}

app.post("/vapi/events", async (request, response) => {
  /*
    Always respond quickly. Vapi should not have to wait while timers run.
  */
  response.status(200).json({ received: true });

  const message = request.body?.message;
  if (!message) return;

  const call =
    message.call ||
    request.body?.call;

  const callId =
    call?.id ||
    message.callId;

  if (!callId) return;

  const state = getCallState(callId);

  const controlUrl =
    call?.monitor?.controlUrl ||
    message?.monitor?.controlUrl;

  if (controlUrl) {
    state.controlUrl = controlUrl;
  }

  /*
    Delete state after the call ends.
  */
  if (
    message.type === "end-of-call-report" ||
    (
      message.type === "status-update" &&
      message.status === "ended"
    )
  ) {
    clearTimers(state);
    calls.delete(callId);
    return;
  }

  const isFinalTranscript =
    message.type === 'transcript[transcriptType="final"]' ||
    (
      message.type === "transcript" &&
      message.transcriptType === "final"
    );

  if (!isFinalTranscript) return;

  const role = message.role;
  const text = message.transcript || "";

  /*
    Any new caller speech cancels pending check-ins and hangups.
  */
  if (role === "user" || role === "customer") {
    clearTimers(state);
    state.generation += 1;
    state.injectedCheckIn = false;

    if (containsHoldPhrase(text)) {
      state.holdUntil = Date.now() + 120_000;
      console.log(`Two-minute hold started for call ${callId}`);
    } else {
      state.holdUntil = 0;
    }

    return;
  }

  /*
    Begin measuring caller silence after Alex finishes speaking.

    Ignore the transcript produced by our injected check-in, because the
    23-second follow-up timer is already running.
  */
  if (role === "assistant") {
    if (state.injectedCheckIn) {
      state.injectedCheckIn = false;
      return;
    }

    scheduleNormalSilenceCheck(callId);
  }
});

app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Alex silence controller listening on port ${PORT}`);
});
