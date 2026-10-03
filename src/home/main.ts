import { openFeedback } from "../shared/feedback";

// The front page is static HTML; this only wires up its 💬 Send feedback button.
document.getElementById("feedback")!.addEventListener("click", () => openFeedback("home"));
