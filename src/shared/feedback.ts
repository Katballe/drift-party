import { appRoot } from "./net";
import { FEEDBACK_CONTACT_MAX, FEEDBACK_MAX, type FeedbackBody, type FeedbackSource } from "./protocol";

/**
 * The "💬 Feedback" form, shared by the big screen and the phones. It's a modal
 * <dialog> on <body>, outside the pages' re-rendered views, so a phone joining
 * or the view changing never wipes what someone is typing; closing it keeps the
 * draft, and only a successful send clears it.
 */
let dialog: HTMLDialogElement | null = null;
let source: FeedbackSource = "screen";
let closeTimer = 0;

const CSS = `
#fb { border: none; border-radius: 18px; padding: 0; margin: auto; width: min(480px, calc(100vw - 32px)); max-height: calc(100dvh - 32px);
  background: #f0ede4; color: #1a2a0a; font-family: 'Caveat', cursive; box-shadow: 0 10px 50px rgba(0,0,0,0.55); }
#fb::backdrop { background: rgba(0,0,0,0.6); }
#fb form { position: relative; display: flex; flex-direction: column; gap: 10px; padding: 20px 22px 18px; }
#fb h2 { font-size: 36px; line-height: 1; }
#fb p { font-size: 19px; color: #6b6450; line-height: 1.2; }
#fb textarea, #fb input { width: 100%; padding: 10px 12px; border: 2px solid #ddd; border-radius: 10px; background: #fff; color: #222;
  font: 16px/1.4 system-ui, sans-serif; outline: none; -webkit-user-select: text; user-select: text; }
#fb textarea { min-height: 130px; resize: vertical; }
#fb textarea:focus, #fb input:focus { border-color: #1a2a0a; }
#fb .fb-trap { position: absolute; left: -10000px; width: 1px; height: 1px; opacity: 0; }
#fb .fb-status { min-height: 20px; font: 15px/1.3 system-ui, sans-serif; color: #888; }
#fb .fb-status.err { color: #E63946; }
#fb .fb-status.ok { color: #2E7D32; font-weight: 700; }
#fb .fb-row { display: flex; justify-content: flex-end; gap: 10px; }
#fb button { border: none; border-radius: 11px; padding: 8px 22px; font: 700 23px 'Caveat', cursive; cursor: pointer; }
#fb .fb-cancel { background: #ddd8c8; color: #444; }
#fb .fb-send { background: #FFD600; color: #1a2a0a; box-shadow: 0 4px 0 #b8920a; }
#fb .fb-send:disabled { opacity: 0.6; cursor: default; }
`;

function build(): HTMLDialogElement {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const d = document.createElement("dialog");
  d.id = "fb";
  d.setAttribute("aria-labelledby", "fb-title");
  d.innerHTML = `<form novalidate>
      <h2 id="fb-title">💬 Send feedback</h2>
      <p>Found a bug, got an idea, love a track? This goes straight to the developer — nobody else can read it.</p>
      <textarea name="message" maxlength="${FEEDBACK_MAX}" placeholder="What's on your mind?" aria-label="Your feedback"></textarea>
      <input name="contact" maxlength="${FEEDBACK_CONTACT_MAX}" placeholder="Name or email (optional)" aria-label="Name or email (optional)" autocomplete="email" />
      <input class="fb-trap" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" />
      <div class="fb-status" role="status"></div>
      <div class="fb-row">
        <button type="button" class="fb-cancel">Cancel</button>
        <button type="submit" class="fb-send">Send ▶</button>
      </div>
    </form>`;
  document.body.appendChild(d);
  const form = d.querySelector("form")!;
  form.addEventListener("submit", (e) => { e.preventDefault(); void send(form); });
  d.querySelector(".fb-cancel")!.addEventListener("click", () => d.close());
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); }); // backdrop
  d.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(form); } });
  d.addEventListener("close", () => clearTimeout(closeTimer));
  return d;
}

function status(text: string, kind: "" | "ok" | "err" = "") {
  const el = dialog?.querySelector<HTMLElement>(".fb-status");
  if (el) { el.textContent = text; el.className = `fb-status ${kind}`; }
}

async function send(form: HTMLFormElement) {
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement;
  const btn = form.querySelector<HTMLButtonElement>(".fb-send")!;
  const body: FeedbackBody = {
    source,
    message: field("message").value.trim(),
    contact: field("contact").value.trim(),
    website: field("website").value,
  };
  if (!body.message) { status("Write something first 🙂", "err"); field("message").focus(); return; }
  btn.disabled = true;
  status("Sending…");
  try {
    const res = await fetch(`${appRoot()}api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      form.reset();
      status("Thanks — got it! 🏁", "ok");
      closeTimer = window.setTimeout(() => dialog?.close(), 1600);
      return;
    }
    status(res.status === 429 ? "That's a lot of feedback at once — try again in a few minutes."
      : res.status === 503 ? "The feedback box is full right now — please try again later."
      : "Couldn't send that — please try again.", "err");
  } catch {
    status("No connection — check your internet and try again.", "err");
  } finally {
    btn.disabled = false;
  }
}

export function openFeedback(from: FeedbackSource) {
  dialog ??= build();
  source = from;
  if (dialog.open) return;
  status("");
  dialog.showModal();
  dialog.querySelector("textarea")!.focus();
}

/** Close it (keeping the draft) — e.g. the phone needs its race controls. */
export function closeFeedback() { if (dialog?.open) dialog.close(); }

export const feedbackOpen = () => !!dialog?.open;
