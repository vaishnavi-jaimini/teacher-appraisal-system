// Builds the 30-question appraisal form (shared by the teacher self-rating
// page and the principal rating page). `variant` is "self" or "principal"
// and only controls the accent color used for selected buttons.

function buildRatingForm(container, { questions, categories, scale, variant, existingRatings, existingComments }) {
  const ratings = existingRatings ? existingRatings.slice() : new Array(questions.length).fill(null);

  const legend = document.createElement("div");
  legend.className = "scale-legend";
  legend.innerHTML = `<span>${scale[0].label} (1)</span><span>${scale[scale.length - 1].label} (5)</span>`;

  const progressTrack = document.createElement("div");
  progressTrack.className = "progress-track";
  const progressFill = document.createElement("div");
  progressFill.className = "progress-fill";
  progressTrack.appendChild(progressFill);

  const progressLabel = document.createElement("div");
  progressLabel.className = "progress-label";

  container.appendChild(progressTrack);
  container.appendChild(progressLabel);
  container.appendChild(legend);

  categories.forEach(cat => {
    const block = document.createElement("div");
    block.className = "category-block";
    const title = document.createElement("div");
    title.className = "category-title";
    title.textContent = cat;
    block.appendChild(title);

    questions.filter(q => q.category === cat).forEach(q => {
      const row = document.createElement("div");
      row.className = "question-row";

      const text = document.createElement("div");
      text.className = "question-text";
      text.innerHTML = `<span class="question-num">${q.id}.</span>${escapeHtml(q.text)}`;
      row.appendChild(text);

      const scaleEl = document.createElement("div");
      scaleEl.className = "scale" + (variant === "principal" ? " principal" : "");

      scale.forEach(s => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = s.value;
        btn.title = s.label;
        btn.dataset.qIndex = q.id - 1;
        btn.dataset.value = s.value;
        if (ratings[q.id - 1] === s.value) btn.classList.add("selected");
        btn.addEventListener("click", () => {
          ratings[q.id - 1] = s.value;
          scaleEl.querySelectorAll("button").forEach(b => b.classList.toggle("selected", Number(b.dataset.value) === s.value));
          updateProgress();
        });
        scaleEl.appendChild(btn);
      });

      row.appendChild(scaleEl);
      block.appendChild(row);
    });

    container.appendChild(block);
  });

  const commentsField = document.createElement("div");
  commentsField.className = "field";
  commentsField.innerHTML = `<label>Additional comments (optional)</label>`;
  const textarea = document.createElement("textarea");
  textarea.value = existingComments || "";
  commentsField.appendChild(textarea);
  container.appendChild(commentsField);

  function updateProgress() {
    const done = ratings.filter(r => r != null).length;
    const pct = Math.round((done / ratings.length) * 100);
    progressFill.style.width = pct + "%";
    progressLabel.textContent = `${done} of ${ratings.length} questions answered`;
  }
  updateProgress();

  return {
    getRatings: () => ratings,
    getComments: () => textarea.value,
    isComplete: () => ratings.every(r => r != null)
  };
}
