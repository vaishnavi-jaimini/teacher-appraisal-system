// Builds the appraisal form (shared by the teacher self-rating page and the
// principal rating page). `variant` is "self" or "principal" and only
// controls the accent color used for selected buttons. Ratings are keyed by
// question id (not array position), so the question bank can be edited by
// the admin without breaking previously-saved answers.
//
// `referenceRatings` (optional, question id -> 1-5) shows a read-only badge
// next to each question — used on the principal's rating page to display
// the teacher's own self-score for that question while she grades it.

function buildRatingForm(container, { questions, categories, scale, variant, existingRatings, existingComments, referenceRatings, referenceLabel }) {
  const ratings = existingRatings ? { ...existingRatings } : {};

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
      const refValue = referenceRatings ? referenceRatings[q.id] : null;
      const refBadge = refValue != null
        ? ` <span class="ref-badge" title="${escapeHtml(referenceLabel || "Reference")} score">${escapeHtml(referenceLabel || "Self")}: ${refValue}</span>`
        : "";
      text.innerHTML = `<span class="question-num">${q.id}.</span>${escapeHtml(q.text)}${refBadge}`;
      row.appendChild(text);

      const scaleEl = document.createElement("div");
      scaleEl.className = "scale" + (variant === "principal" ? " principal" : "");

      scale.forEach(s => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = s.value;
        btn.title = s.label;
        btn.dataset.value = s.value;
        if (ratings[q.id] === s.value) btn.classList.add("selected");
        btn.addEventListener("click", () => {
          ratings[q.id] = s.value;
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
    const done = questions.filter(q => ratings[q.id] != null).length;
    const pct = Math.round((done / questions.length) * 100);
    progressFill.style.width = pct + "%";
    progressLabel.textContent = `${done} of ${questions.length} questions answered`;
  }
  updateProgress();

  return {
    getRatings: () => ratings,
    getComments: () => textarea.value,
    isComplete: () => questions.every(q => ratings[q.id] != null)
  };
}
