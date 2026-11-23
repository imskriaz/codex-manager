import { useEffect, useRef, useState } from "preact/hooks";
import { ModalShell } from "./primitives";

const MAX_DICTATION_LENGTH = 64_000;

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

export type DictationNotice = { level: "info" | "warning"; message: string };

export function appendDictationText(current: string, transcript: string, maxLength = MAX_DICTATION_LENGTH): string {
  const next = `${current}${current.trim() ? " " : ""}${transcript.trim()}`;
  return next.slice(0, maxLength);
}

export function dictationErrorMessage(error: string): string {
  return (
    (
      {
        "not-allowed": "Microphone access was denied. Allow it in the browser, then try again.",
        "audio-capture": "No microphone is available. Check the selected input device.",
        "no-speech": "No speech was detected. Start again when you are ready.",
        network: "The browser speech service is unavailable. Captured text is kept."
      } as Record<string, string>
    )[error] ?? "Dictation stopped unexpectedly. Captured text is kept."
  );
}

function defaultLanguage(language?: string): string {
  if (language && language !== "auto") {
    return language;
  }
  return globalThis.navigator?.language || "en-US";
}

export function VoiceDictation(props: {
  disabled?: boolean;
  language?: string;
  scope?: string;
  onText: (value: string) => boolean;
  onFeedback?: (notice: DictationNotice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<"starting" | "listening" | "stopping">("starting");
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [notice, setNotice] = useState<DictationNotice>();
  const [language, setLanguage] = useState(() => defaultLanguage(props.language));
  const recognition = useRef<Recognition | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const opening = useRef(false);
  const stopping = useRef(false);

  const releaseRecognition = () => {
    if (stopTimer.current !== undefined) {
      clearTimeout(stopTimer.current);
      stopTimer.current = undefined;
    }
    const current = recognition.current;
    recognition.current = null;
    stopping.current = false;
    if (!current) {
      return;
    }
    current.onresult = null;
    current.onstart = null;
    current.onerror = null;
    current.onend = null;
    try {
      current.abort();
    } catch {
      // Browsers can throw when aborting after recognition has already ended.
    }
  };

  useEffect(() => () => releaseRecognition(), []);

  useEffect(() => {
    releaseRecognition();
    opening.current = false;
    setActive(false);
    setOpen(false);
    setText("");
    setInterim("");
    setNotice(undefined);
  }, [props.scope]);

  useEffect(() => {
    setLanguage(defaultLanguage(props.language));
  }, [props.language]);

  const finish = (message: string, level: DictationNotice["level"] = "info") => {
    releaseRecognition();
    opening.current = false;
    setActive(false);
    setInterim("");
    setNotice({ level, message });
  };

  const stop = () => {
    const current = recognition.current;
    if (!current || stopping.current) {
      return;
    }
    stopping.current = true;
    clearTimeout(stopTimer.current);
    setPhase("stopping");
    setNotice({ level: "info", message: "Finishing dictation…" });
    stopTimer.current = setTimeout(
      () => finish("Speech recognition did not confirm stopping. Captured text is kept.", "warning"),
      3_000
    );
    try {
      current.stop();
    } catch {
      finish("Dictation could not stop cleanly. Captured text is kept.", "warning");
    }
  };

  const start = () => {
    if (props.disabled || recognition.current || opening.current) {
      return;
    }
    const speechWindow = window as SpeechWindow;
    const Constructor = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Constructor || !window.isSecureContext) {
      setNotice({
        level: "warning",
        message: "Voice dictation is unavailable here. Use system dictation or type your message."
      });
      return;
    }

    opening.current = true;
    try {
      const current = new Constructor();
      recognition.current = current;
      current.lang = language;
      current.continuous = true;
      current.interimResults = true;
      const finalized = new Set<number>();
      current.onstart = () => {
        if (recognition.current !== current || stopping.current) return;
        clearTimeout(stopTimer.current);
        setPhase("listening");
        setNotice({ level: "info", message: "Listening… Speak naturally, then stop when finished." });
        stopTimer.current = setTimeout(stop, 90_000);
      };
      current.onresult = (event) => {
        if (recognition.current !== current) return;
        let finalText = "";
        let interimText = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (!result) {
            continue;
          }
          if (result.isFinal) {
            if (!finalized.has(index)) finalText += `${result[0].transcript} `;
            finalized.add(index);
          } else {
            interimText += result[0].transcript;
          }
        }
        if (finalText) {
          setText((value) => appendDictationText(value, finalText));
        }
        setInterim(interimText.trim());
      };
      current.onerror = (event) => finish(dictationErrorMessage(event.error), "warning");
      current.onend = () => finish("Dictation stopped. Review the captured text.");
      setActive(true);
      setPhase("starting");
      setNotice({ level: "info", message: "Starting microphone… Allow access if prompted." });
      stopTimer.current = setTimeout(
        () => finish("The microphone did not start. Check access and try again.", "warning"),
        10_000
      );
      current.start();
      opening.current = false;
    } catch {
      finish("Dictation could not start. Check microphone access and try again.", "warning");
    }
  };

  const close = () => {
    releaseRecognition();
    opening.current = false;
    setActive(false);
    setOpen(false);
    setText("");
    setInterim("");
    const result: DictationNotice = { level: "info", message: "Dictation cancelled. Your draft was not changed." };
    setNotice(result);
    props.onFeedback?.(result);
  };

  const useText = () => {
    const value = text.trim();
    if (!value || active || props.disabled) {
      return;
    }
    if (!props.onText(value)) {
      setNotice({ level: "warning", message: "The message is too long. Shorten the captured text or existing draft." });
      return;
    }
    releaseRecognition();
    opening.current = false;
    setActive(false);
    setOpen(false);
    setText("");
    setInterim("");
    const result: DictationNotice = { level: "info", message: "Dictation added. Review the message before sending." };
    setNotice(result);
    props.onFeedback?.(result);
  };

  return (
    <>
      <button
        type="button"
        class="cli-attach-button voice-dictation-trigger"
        disabled={props.disabled}
        aria-label="Dictate message"
        title="Dictate message"
        onClick={() => {
          setOpen(true);
          setText("");
          setInterim("");
          setNotice(undefined);
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <rect x="9" y="3" width="6" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path
            d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3m-4 0h8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <ModalShell
        open={open}
        title="Voice dictation"
        closeLabel="Close voice dictation"
        className="dashboard-modal-compact voice-dictation-modal"
        onClose={close}
      >
        <div class="voice-dictation">
          <div class="voice-dictation-intro">
            <span class={`voice-dictation-indicator${active ? " is-active" : ""}`} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <div>
              <strong>
                {active
                  ? phase === "starting"
                    ? "Starting microphone"
                    : phase === "stopping"
                      ? "Finishing dictation"
                      : "Listening"
                  : "Speak your message"}
              </strong>
              <small>Review the text before adding it to your draft.</small>
            </div>
          </div>
          <label class="voice-dictation-language">
            Language
            <select disabled={active} value={language} onChange={(event) => setLanguage(event.currentTarget.value)}>
              {!["en-US", "en-GB", "bn-BD", "hi-IN"].includes(language) ? (
                <option value={language}>{language}</option>
              ) : null}
              <option value="en-US">English (US)</option>
              <option value="en-GB">English (UK)</option>
              <option value="bn-BD">বাংলা (বাংলাদেশ)</option>
              <option value="hi-IN">हिन्दी</option>
            </select>
          </label>
          <label class="voice-dictation-capture">
            Captured text
            <textarea
              rows={5}
              maxLength={MAX_DICTATION_LENGTH}
              placeholder="Your words will appear here…"
              value={text}
              readOnly={active}
              onInput={(event) => setText(event.currentTarget.value)}
            />
          </label>
          <small class="voice-dictation-privacy">Your browser may send audio to its speech service.</small>
          {text.length === MAX_DICTATION_LENGTH ? (
            <p class="voice-dictation-notice is-warning" role="alert">
              Text limit reached. Further speech cannot be added.
            </p>
          ) : null}
          {interim ? (
            <p class="voice-interim" aria-live="polite">
              <span>Hearing</span>
              {interim}
            </p>
          ) : null}
          {notice ? (
            <p
              class={`voice-dictation-notice is-${notice.level}`}
              role={notice.level === "warning" ? "alert" : "status"}
            >
              {notice.message}
            </p>
          ) : null}
          <div class="workspace-dialog-footer">
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              class={!active && text.trim() ? undefined : "primary"}
              disabled={(active && phase === "stopping") || (!active && props.disabled)}
              onClick={active ? stop : start}
            >
              {active ? (phase === "stopping" ? "Finishing…" : "Stop") : "Start dictation"}
            </button>
            <button
              type="button"
              class={!active && text.trim() ? "primary" : undefined}
              disabled={active || props.disabled || !text.trim()}
              onClick={useText}
            >
              Use text
            </button>
          </div>
        </div>
      </ModalShell>
      {!open && notice ? (
        <span class="sr-only" role={notice.level === "warning" ? "alert" : "status"}>
          {notice.message}
        </span>
      ) : null}
    </>
  );
}
