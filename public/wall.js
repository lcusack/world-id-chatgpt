const answersElement = document.querySelector("#answers");
const countElement = document.querySelector("#answer-count");
const questionElement = document.querySelector("#question-heading");
const copyButton = document.querySelector("#copy-prompt");
const promptElement = document.querySelector("#starter-prompt");

function formatDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function renderAnswer(answer) {
  const article = document.createElement("article");
  article.className = "answer";

  const body = document.createElement("p");
  body.className = "answer-body";
  body.textContent = answer.body;

  const meta = document.createElement("div");
  meta.className = "answer-meta";
  const verified = document.createElement("span");
  verified.className = "verified-label";
  verified.textContent = "Orb-verified account";
  const time = document.createElement("time");
  time.dateTime = answer.created_at;
  time.textContent = formatDate(answer.created_at);
  meta.append(verified, time);
  article.append(body, meta);
  return article;
}

async function loadWall() {
  try {
    const response = await fetch("/api/wall?limit=50", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("The wall could not be loaded");
    const wall = await response.json();
    questionElement.textContent = wall.question.prompt;
    countElement.textContent = `${wall.answer_count} verified ${wall.answer_count === 1 ? "answer" : "answers"}`;
    answersElement.replaceChildren();
    if (wall.answers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "The wall is ready. Be the first verified human to answer.";
      answersElement.append(empty);
      return;
    }
    for (const answer of wall.answers) answersElement.append(renderAnswer(answer));
  } catch {
    countElement.textContent = "Wall temporarily unavailable";
    const error = document.createElement("div");
    error.className = "error";
    error.textContent = "We couldn’t load the wall. Please try again in a moment.";
    answersElement.replaceChildren(error);
  }
}

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(promptElement.textContent.trim());
    copyButton.textContent = "Copied";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(promptElement);
    selection.removeAllRanges();
    selection.addRange(range);
    copyButton.textContent = "Selected—copy it";
  }
});

loadWall();
