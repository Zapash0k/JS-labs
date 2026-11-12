// Chat + roster overlay (DOM only). Driven by the Connection's messages.
export function mountChat(root, conn) {
  const ui = new AbortController();
  const { signal } = ui;

  const roster = Object.assign(document.createElement("div"), { className: "roster" });
  const log = Object.assign(document.createElement("div"), { className: "log" });
  const input = Object.assign(document.createElement("input"), {
    placeholder: "Enter to chat",
    maxLength: 280,
  });
  root.replaceChildren(roster, log, input);
  root.hidden = false;

  const line = (text, className = "") => {
    log.append(Object.assign(document.createElement("div"), { textContent: text, className }));
    while (log.children.length > 50) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  };

  const offs = [
    conn.on("roster", (m) => {
      roster.textContent = `${m.players.length} in room: ${m.players.map((p) => p.name).join(", ")}`;
    }),
    conn.on("chat", (m) => line(`${m.from.name}: ${m.text}`)),
    conn.on("error", (m) => line(`server: ${m.message}`, "sys")),
  ];
  conn.addEventListener("reconnecting", () => line("connection lost, reconnecting…", "sys"), {
    signal,
  });
  conn.addEventListener("open", () => line("connected", "sys"), { signal });
  conn.addEventListener(
    "close",
    (e) =>
      e.detail.code !== 1006 && line(`disconnected (${e.detail.code} ${e.detail.reason})`, "sys"),
    { signal },
  );

  input.addEventListener(
    "keydown",
    (e) => {
      e.stopPropagation(); // typing must not steer the ship
      if (e.key === "Escape") input.blur();
      if (e.key === "Enter" && input.value.trim()) {
        conn.send({ type: "chat", text: input.value.trim() });
        input.value = "";
      }
    },
    { signal },
  );
  input.addEventListener("keyup", (e) => e.stopPropagation(), { signal });
  // Enter anywhere else focuses the chat box.
  window.addEventListener(
    "keydown",
    (e) =>
      e.code === "Enter" && document.activeElement !== input && (e.preventDefault(), input.focus()),
    { signal },
  );

  return {
    destroy() {
      ui.abort();
      offs.forEach((off) => off());
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
