const button = document.getElementById("copy-install");
const command = document.getElementById("install-command");
const feedback = document.getElementById("install-feedback");

button.hidden = false;
button.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(command.textContent.trim());
    feedback.textContent = "Command copied.";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(command);
    selection.removeAllRanges();
    selection.addRange(range);
    feedback.textContent =
      "Copy unavailable. The command is selected — copy it manually.";
  }
});
