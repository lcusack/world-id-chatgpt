const copyButtons = document.querySelectorAll("[data-copy-value]");

for (const button of copyButtons) {
  button.addEventListener("click", async () => {
    const value = button.dataset.copyValue;
    if (!value) return;

    button.textContent = "Copying…";
    let copied = false;

    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await Promise.race([
        navigator.clipboard.writeText(value),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("Clipboard timed out")), 750)),
      ]);
      copied = true;
    } catch {
      const input = document.createElement("input");
      input.value = value;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      copied = document.execCommand("copy");
      input.remove();
    }

    button.textContent = copied ? "Copied" : "Copy the URL above";
  });
}
