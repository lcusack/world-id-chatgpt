const template = document.querySelector("#proposal-template");
const copyButtons = document.querySelectorAll("[data-copy-template]");

async function copyTemplate(button) {
  const value = template?.textContent?.trim();
  if (!value) return;
  const original = button.textContent;
  button.textContent = "Copying…";
  let copied = false;

  try {
    if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(value);
    copied = true;
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    copied = document.execCommand("copy");
    area.remove();
  }

  button.textContent = copied ? "Copied" : "Select the template below";
  window.setTimeout(() => { button.textContent = original; }, 1_600);
}

for (const button of copyButtons) {
  button.addEventListener("click", () => copyTemplate(button));
}
