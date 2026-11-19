import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";

// Two real browsers, one real server. This is the most convincing test in the repo: client, protocol,
// server and simulation all have to work together for any of it to pass.

/** The movement must show up in the other browser within this long after the key goes down. */
const MOVEMENT_BUDGET_MS = 500;

interface Point {
  x: number;
  y: number;
}
interface Drawable {
  kind: string;
  own?: boolean;
  pos: Point;
}
declare global {
  interface Window {
    // set by client/src/main.js when the URL has ?e2e
    __dogfight?: { getNetGame(): { drawables(alpha?: number): Drawable[] } | null };
  }
}

/** Where this page draws the OTHER player's ship right now (null: not on screen yet). */
const otherShip = (page: Page): Promise<Point | null> =>
  page.evaluate(() => {
    const ships = window.__dogfight?.getNetGame()?.drawables(1) ?? [];
    const other = ships.find((d) => d.kind === "ship" && !d.own);
    return other ? { x: other.pos.x, y: other.pos.y } : null;
  });

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Creates a fresh room over HTTP, so every test starts from its own empty room. */
async function createRoom(page: Page): Promise<string> {
  const name = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await page.request.post("/api/rooms", { data: { name } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function joinRoom(page: Page, roomId: string, callsign: string): Promise<void> {
  await page.goto("/?e2e");
  await page.locator("#lobby label input").fill(callsign);
  await page.locator(`#lobby button[data-room="${roomId}"]`).click();
  await expect(page.locator("#chat")).toBeVisible(); // the chat overlay appears once the server said "joined"
}

interface Pair {
  alice: Page;
  bob: Page;
}

/** Two separate browser contexts (two players, no shared storage) in the same room. */
async function withTwoPlayers(browser: Browser, run: (pair: Pair) => Promise<void>): Promise<void> {
  const contexts: BrowserContext[] = [await browser.newContext(), await browser.newContext()];
  try {
    const [alice, bob] = await Promise.all(contexts.map((c) => c.newPage()));
    if (!alice || !bob) throw new Error("could not open two pages");
    const roomId = await createRoom(alice);
    await joinRoom(alice, roomId, "Alice");
    await joinRoom(bob, roomId, "Bob");
    await run({ alice, bob });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
}

test("both players join one room and see the same roster", async ({ browser }) => {
  await withTwoPlayers(browser, async ({ alice, bob }) => {
    for (const page of [alice, bob]) {
      const roster = page.locator("#chat .roster");
      await expect(roster).toContainText("2 in room");
      await expect(roster).toContainText("Alice");
      await expect(roster).toContainText("Bob");
    }
  });
});

test("a chat message from one player reaches the other", async ({ browser }) => {
  await withTwoPlayers(browser, async ({ alice, bob }) => {
    const box = alice.locator("#chat input");
    await box.fill("hello from alice");
    await box.press("Enter");
    await expect(bob.locator("#chat .log")).toContainText("Alice: hello from alice");
    await expect(alice.locator("#chat .log")).toContainText("Alice: hello from alice"); // echoed to the sender too
  });
});

test(`when Alice flies, Bob sees her ship move within ${MOVEMENT_BUDGET_MS} ms`, async ({
  browser,
}) => {
  await withTwoPlayers(browser, async ({ alice, bob }) => {
    // Bob needs Alice's ship on screen first. A ship without input does not advance, so it holds still.
    await expect.poll(() => otherShip(bob), { timeout: 5000 }).not.toBeNull();
    const before = await otherShip(bob);
    if (!before) throw new Error("Bob cannot see Alice's ship");

    const started = Date.now();
    await alice.keyboard.down("ArrowUp"); // thrust
    await expect
      .poll(async () => distance(before, (await otherShip(bob)) ?? before), {
        timeout: MOVEMENT_BUDGET_MS,
        intervals: [20],
        message: `Bob should see Alice's ship move within ${MOVEMENT_BUDGET_MS} ms`,
      })
      .toBeGreaterThan(3); // pixels
    console.log(`movement became visible to the other player after ${Date.now() - started} ms`);
    await alice.keyboard.up("ArrowUp");
  });
});
