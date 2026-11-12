/**
 * Keyboard input as a closure: `down` and `pressed` are private.
 * `justPressed` is edge-triggered: true from the keydown until `endStep()`
 * is called, which the game does after every simulation step.
 */
export function createInput(target = window) {
  const down = new Set();
  const pressed = new Set();

  // Typing in the chat/lobby text fields must not steer the ship.
  const typing = (e) =>
    e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

  target.addEventListener("keydown", (e) => {
    if (typing(e)) return;
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
    if (!down.has(e.code)) pressed.add(e.code);
    down.add(e.code);
  });
  target.addEventListener("keyup", (e) => {
    if (typing(e)) return;
    down.delete(e.code);
  });
  target.addEventListener("blur", () => {
    down.clear();
    pressed.clear();
  });

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    endStep: () => pressed.clear(),
  };
}
