// Renders a grouped bar chart comparing self-rating vs principal-rating
// category averages, as inline SVG. Self = blue (series-1), Principal =
// orange (series-2) — a validated adjacent categorical pair.

function renderComparisonChart(container, categoryAverages) {
  const css = getComputedStyle(document.documentElement);
  const colorSelf = css.getPropertyValue("--series-self").trim();
  const colorPrincipal = css.getPropertyValue("--series-principal").trim();
  const colorGrid = css.getPropertyValue("--gridline").trim();
  const colorMuted = css.getPropertyValue("--text-muted").trim();
  const colorAxis = css.getPropertyValue("--border-strong").trim();

  const data = categoryAverages;
  const W = container.clientWidth || 900;
  const H = 340;
  const marginLeft = 34;
  const marginRight = 12;
  const marginTop = 16;
  const marginBottom = 90;
  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop - marginBottom;
  const maxVal = 5;

  const groupW = plotW / data.length;
  const barW = Math.min(22, groupW * 0.28);
  const gap = 3;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", H);
  svg.style.overflow = "visible";
  svg.style.fontFamily = "system-ui, -apple-system, Segoe UI, sans-serif";

  function y(v) { return marginTop + plotH - (v / maxVal) * plotH; }

  // Gridlines + axis labels (0..5)
  for (let v = 0; v <= maxVal; v++) {
    const gy = y(v);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", marginLeft);
    line.setAttribute("x2", W - marginRight);
    line.setAttribute("y1", gy);
    line.setAttribute("y2", gy);
    line.setAttribute("stroke", v === 0 ? colorAxis : colorGrid);
    line.setAttribute("stroke-width", "1");
    svg.appendChild(line);

    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", marginLeft - 8);
    label.setAttribute("y", gy + 4);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("font-size", "11");
    label.setAttribute("fill", colorMuted);
    label.textContent = v;
    svg.appendChild(label);
  }

  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  container.style.position = "relative";
  container.appendChild(tooltip);

  function showTip(evt, text) {
    tooltip.textContent = text;
    tooltip.classList.add("show");
    const rect = container.getBoundingClientRect();
    tooltip.style.left = evt.clientX - rect.left + 12 + "px";
    tooltip.style.top = evt.clientY - rect.top - 28 + "px";
  }
  function hideTip() { tooltip.classList.remove("show"); }

  data.forEach((d, i) => {
    const groupX = marginLeft + i * groupW + groupW / 2;

    [
      { value: d.self, color: colorSelf, dx: -gap / 2 - barW, label: "Self" },
      { value: d.principal, color: colorPrincipal, dx: gap / 2, label: "Principal" }
    ].forEach(bar => {
      const v = bar.value == null ? 0 : bar.value;
      const barH = (v / maxVal) * plotH;
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", groupX + bar.dx);
      rect.setAttribute("y", y(v));
      rect.setAttribute("width", barW);
      rect.setAttribute("height", Math.max(barH, bar.value != null ? 2 : 0));
      rect.setAttribute("fill", bar.value == null ? "transparent" : bar.color);
      rect.setAttribute("rx", "4");
      rect.style.cursor = bar.value != null ? "pointer" : "default";
      if (bar.value != null) {
        rect.addEventListener("mousemove", evt => showTip(evt, `${d.category} — ${bar.label}: ${bar.value.toFixed(2)}`));
        rect.addEventListener("mouseleave", hideTip);
      }
      svg.appendChild(rect);
    });

    // Category label (rotated for space)
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", 0);
    label.setAttribute("y", 0);
    label.setAttribute("font-size", "11");
    label.setAttribute("fill", colorMuted);
    label.setAttribute("transform", `translate(${groupX}, ${H - marginBottom + 14}) rotate(28)`);
    label.setAttribute("text-anchor", "start");
    // wrap long category names
    const words = d.category.split(" ");
    label.textContent = d.category.length > 26 ? words.slice(0, 3).join(" ") + "…" : d.category;
    svg.appendChild(label);
  });

  container.innerHTML = "";
  container.appendChild(svg);
  container.appendChild(tooltip);
}
