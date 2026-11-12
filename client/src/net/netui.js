// Sliders and switches for the networking experiments (DOM only). The latency injector lives on the
// server (it delays this socket's traffic in both directions); the rest is client-side.
export function mountNetUi(root, net, initial = {}) {
  const ui = new AbortController();
  const { signal } = ui;
  root.replaceChildren();
  root.hidden = false;
  const sim = { rtt: initial.rtt ?? 0, jitter: initial.jitter ?? 0, drop: initial.drop ?? 0 };

  function slider(label, min, max, value, unit, onInput) {
    const row = document.createElement("label");
    const text = document.createElement("span");
    const input = Object.assign(document.createElement("input"), {
      type: "range",
      min,
      max,
      value,
    });
    const show = () => (text.textContent = `${label}: ${input.value} ${unit}`);
    input.addEventListener("input", () => (show(), onInput(Number(input.value))), { signal });
    show();
    row.append(text, input);
    root.append(row);
  }
  function toggle(label, checked, onChange) {
    const row = document.createElement("label");
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked });
    box.addEventListener("change", () => onChange(box.checked), { signal });
    row.append(box, ` ${label}`);
    root.append(row);
  }
  const pushSim = () => net.setNetsim(sim);

  slider("added RTT", 0, 400, sim.rtt, "ms", (v) => ((sim.rtt = v), pushSim()));
  slider("jitter", 0, 150, sim.jitter, "ms", (v) => ((sim.jitter = v), pushSim()));
  slider("packet drop", 0, 20, sim.drop, "%", (v) => ((sim.drop = v), pushSim()));
  slider("interpolation delay", 0, 300, net.interp.delayMs, "ms", (v) =>
    net.setInterpolationDelay(v),
  );
  toggle("client-side prediction", net.options.predict, (v) => (net.options.predict = v));
  toggle("reconciliation", net.options.reconcile, (v) => (net.options.reconcile = v));
  toggle(
    "break determinism (Math.random in prediction)",
    net.options.nondeterministic,
    (v) => (net.options.nondeterministic = v),
  );

  // typing in these controls must not steer the ship
  for (const type of ["keydown", "keyup"])
    root.addEventListener(type, (e) => e.stopPropagation(), { signal });

  return {
    destroy() {
      ui.abort();
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
