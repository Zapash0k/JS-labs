// Lobby rendering (Lab 03, M3): DOM only, driven by the Lobby's events.
import { HttpError } from "../assets/loader.js";

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
  const newName = Object.assign(document.createElement("input"), {
    placeholder: "new room name",
    maxLength: 32,
  });
  const create = Object.assign(document.createElement("button"), { textContent: "Create room" });
  const form = document.createElement("div");
  form.className = "create";
  form.append(newName, create);
  root.replaceChildren(title, label, status, list, form);
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

  const setStatus = (text, isError = false) => {
    status.className = isError ? "status error" : "status";
    status.textContent = text;
  };

  create.addEventListener(
    "click",
    async () => {
      const wanted = newName.value.trim();
      if (!wanted) return;
      try {
        await lobby.createRoom(wanted);
        newName.value = "";
      } catch (err) {
        const reason =
          err instanceof HttpError && err.status === 409
            ? "that name is taken"
            : err instanceof HttpError && err.status === 422
              ? "invalid room name"
              : err.message;
        setStatus(`Cannot create the room: ${reason}`, true);
      }
    },
    { signal },
  );

  return {
    setStatus,
    destroy() {
      ui.abort();
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
