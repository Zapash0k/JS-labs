// Lobby rendering (Lab 03, M3): DOM only, driven by the Lobby's events.
export function mountLobbyView(root, lobby) {
  const ui = new AbortController(); // one abort removes every listener below
  const { signal } = ui;

  const title = Object.assign(document.createElement("h1"), { textContent: "Dogfight — lobby" });
  const label = Object.assign(document.createElement("label"), { textContent: "Callsign " });
  const name = Object.assign(document.createElement("input"), { value: "Pilot", maxLength: 16 });
  label.append(name);
  const status = Object.assign(document.createElement("p"), {
    className: "status",
    textContent: "Loading rooms…",
  });
  const list = document.createElement("ul");
  root.replaceChildren(title, label, status, list);
  root.hidden = false;

  function renderRooms(rooms) {
    list.replaceChildren(
      ...rooms.map((room) => {
        const li = document.createElement("li");
        const info = Object.assign(document.createElement("span"), {
          textContent: `${room.name} — ${room.players}/${room.maxPlayers}`,
        });
        const btn = Object.assign(document.createElement("button"), {
          textContent: "Join",
          disabled: room.players >= room.maxPlayers,
        });
        btn.dataset.room = room.id;
        li.append(info, btn);
        return li;
      }),
    );
    status.className = "status";
    status.textContent = `${rooms.length} rooms · updated ${new Date().toLocaleTimeString()}`;
  }

  lobby.addEventListener("roomsChanged", (e) => renderRooms(e.detail), { signal });
  lobby.addEventListener(
    "failed",
    (e) => {
      status.className = "status error";
      status.textContent = `Cannot reach the server (${e.detail.message}). Retrying…`;
    },
    { signal },
  );
  root.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest("button[data-room]");
      if (btn) lobby.join(btn.dataset.room, name.value.trim() || "Pilot");
    },
    { signal },
  );

  return {
    destroy() {
      ui.abort();
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
