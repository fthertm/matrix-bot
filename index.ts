import { DurableObject } from 'cloudflare:workers';
import { MatrixBotDO, type BotMessage } from '@ixo/matrix-bot-workers-sdk';

const BOT_INSTANCE_NAME = 'Matrix-Bot';
const REMINDER_INSTANCE_NAME = 'Reminders';
const INSPIRO_API_URL = 'https://inspirobot.me/api?generate=true';
const CATFACT_API_URL = 'https://catfact.ninja/fact';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const COOLDOWN_MS = 1_000;
const REMINDER_MAX_ATTEMPTS = 5;
const REMINDER_RETRY_MS = 10_000;
const CLEAR_PAGE_SIZE = 100;
const RATE_LIMIT_MAX_RETRIES = 10;
const RATE_LIMIT_DEFAULT_WAIT_MS = 5_000;

// Matrix user IDs that may invite the bot and mute/unmute it.
const BOT_ADMINS = new Set([
  '@fatih:federated.nexus',
  '@usr40k:usr40k.dev',
]);

const COMMAND_PREFIX = '!faith';

const REMIND_USAGE = `usage: ${COMMAND_PREFIX} remind <in 10m | 2026-01-02 15:04 | 15:04> <text...>`;

const HELP_TEXT = [
  'Commands:',
  `${COMMAND_PREFIX} inspire - random inspiring image`,
  `${COMMAND_PREFIX} catfact - random cat fact`,
  `${COMMAND_PREFIX} meow - random meow from 7w1 s meow api`,
  `${COMMAND_PREFIX} remind <when> <text> - post a reminder in this room. <when>: 2026-01-02 15:04 (times are UTC)`,
  `${COMMAND_PREFIX} help - show this message`,
].join('\n');

const KNOWN_COMMANDS = new Set(['help', 'inspire', 'catfact', 'meow', 'remind']);

// Durable Object storage key prefix for per-room mute flags.
const MUTE_KEY_PREFIX = 'faith:muted:';

const lastUse = new Map<string, number>();
const clearing = new Set<string>();

interface InspiroImage {
  bytes: Uint8Array;
  mimetype: string;
  filename: string;
}

interface MessagesPage {
  chunk?: { event_id: string; unsigned?: { redacted_because?: unknown } }[];
  end?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function acquireCooldown(roomId: string): boolean {
  const now = Date.now();
  if (now - (lastUse.get(roomId) ?? 0) < COOLDOWN_MS) return false;
  lastUse.set(roomId, now);
  return true;
}

async function isRoomMuted(storage: DurableObjectStorage, roomId: string): Promise<boolean> {
  return (await storage.get<boolean>(MUTE_KEY_PREFIX + roomId)) === true;
}

async function setRoomMuted(storage: DurableObjectStorage, roomId: string, muted: boolean): Promise<void> {
  if (muted) await storage.put(MUTE_KEY_PREFIX + roomId, true);
  else await storage.delete(MUTE_KEY_PREFIX + roomId);
}

async function fetchInspiroImage(): Promise<InspiroImage> {
  const apiResponse = await fetch(INSPIRO_API_URL);
  if (!apiResponse.ok) throw new Error(`inspirobot request failed: HTTP ${apiResponse.status}`);

  const imageUrl = (await apiResponse.text()).trim();
  if (!imageUrl.startsWith('https://')) {
    throw new Error(`unexpected inspirobot response: ${imageUrl.slice(0, 80)}`);
  }

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error(`image download failed: HTTP ${imageResponse.status}`);

  const mimetype = imageResponse.headers.get('content-type')?.split(';')[0].trim() || 'image/jpeg';
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`image too large: ${bytes.byteLength} bytes`);

  const extension = mimetype === 'image/png' ? 'png' : 'jpg';
  return { bytes, mimetype, filename: `inspirobot.${extension}` };
}

const DAY_MS = 86_400_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:\d{2})$/i;
const RELATIVE_PATTERN = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const ABSOLUTE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const CLOCK_PATTERN = /^(\d{1,2}):(\d{2})$/;

function utcTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(timestamp);
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return valid ? timestamp : null;
}

function parseWhen(input: string, now: number): number | null {
  const raw = input.trim();
  if (RFC3339_PATTERN.test(raw)) {
    const parsed = Date.parse(raw.toUpperCase());
    return Number.isNaN(parsed) ? null : parsed;
  }

  let value = raw.toLowerCase();
  if (value.startsWith('in')) value = value.slice(2).trim();
  if (!value) return null;

  const relative = RELATIVE_PATTERN.exec(value);
  if (relative) {
    const [, days, hours, minutes, seconds] = relative;
    const total =
      (Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) *
      1000;
    const due = now + total;
    if (total > 0 && due <= MAX_TIMESTAMP) return due;
  }

  const absolute = ABSOLUTE_PATTERN.exec(value);
  if (absolute) {
    const [, year, month, day, hour, minute, second] = absolute;
    return utcTimestamp(
      Number(year),
      Number(month),
      Number(day),
      Number(hour ?? 0),
      Number(minute ?? 0),
      Number(second ?? 0),
    );
  }

  const clock = CLOCK_PATTERN.exec(value);
  if (clock) {
    const today = new Date(now);
    const timestamp = utcTimestamp(
      today.getUTCFullYear(),
      today.getUTCMonth() + 1,
      today.getUTCDate(),
      Number(clock[1]),
      Number(clock[2]),
      0,
    );
    if (timestamp === null) return null;
    return timestamp > now ? timestamp : timestamp + DAY_MS;
  }

  return null;
}

function extractReminder(args: string[], now: number): { due: number; text: string } | null {
  for (const size of [2, 1]) {
    if (args.length < size) continue;
    const due = parseWhen(args.slice(0, size).join(' '), now);
    if (due !== null) return { due, text: args.slice(size).join(' ') };
  }
  return null;
}

function formatUtc(timestamp: number): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

async function fetchCatFact(): Promise<string> {
  try {
    const response = await fetch(CATFACT_API_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { fact?: string };
    if (!data.fact) throw new Error('empty response');
    return data.fact;
  } catch (error) {
    throw new Error(`could not get cat fact: ${errorMessage(error)}`);
  }
}

async function fetchMeow(baseUrl: string | undefined): Promise<string> {
  if (!baseUrl) throw new Error('MEOW_BASE_URL is not set in wrangler.toml');
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/meow`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { meow?: string };
    if (!data.meow) throw new Error('empty response');
    return `\u{1F408} ${data.meow}`;
  } catch (error) {
    throw new Error(`meow service failed: ${errorMessage(error)}`);
  }
}

async function matrixRequest<T>(url: string, init: RequestInit): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
      const { retry_after_ms } = (await response.json().catch(() => ({}))) as { retry_after_ms?: number };
      await new Promise((resolve) => setTimeout(resolve, retry_after_ms ?? RATE_LIMIT_DEFAULT_WAIT_MS));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return (await response.json()) as T;
  }
}

async function deleteBotMessages(baseUrl: string, accessToken: string, userId: string, roomId: string): Promise<void> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const roomPath = `${baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
  const filter = encodeURIComponent(
    JSON.stringify({ senders: [userId], types: ['m.room.message', 'm.room.encrypted'] }),
  );

  let from: string | undefined;
  do {
    const cursor = from ? `&from=${encodeURIComponent(from)}` : '';
    const page = await matrixRequest<MessagesPage>(
      `${roomPath}/messages?dir=b&limit=${CLEAR_PAGE_SIZE}&filter=${filter}${cursor}`,
      { headers },
    );
    if (!page) return;

    const events = page.chunk ?? [];
    for (const event of events) {
      if (event.unsigned?.redacted_because) continue;
      await matrixRequest(`${roomPath}/redact/${encodeURIComponent(event.event_id)}/${crypto.randomUUID()}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
      });
    }
    from = events.length > 0 && page.end !== from ? page.end : undefined;
  } while (from);
}

async function createReminder(env: Env, roomId: string, threadId: string | null, args: string[]): Promise<string> {
  if (args.length < 2) return REMIND_USAGE;

  const now = Date.now();
  const reminder = extractReminder(args, now);
  if (!reminder) {
    throw new Error(`couldn't parse time "${args[0]}" (try "10m", "1d", "15:04", or "2026-01-02 15:04")`);
  }
  if (!reminder.text) return REMIND_USAGE;
  if (reminder.due <= now) throw new Error('that time is in the past, pick a future time');

  const store = env.REMINDER_DO.get(env.REMINDER_DO.idFromName(REMINDER_INSTANCE_NAME));
  await store.schedule(roomId, threadId, reminder.due, reminder.text);
  return `ok, I'll remind you at ${formatUtc(reminder.due)}`;
}

export class ReminderStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, due INTEGER NOT NULL, room_id TEXT NOT NULL, thread_id TEXT, text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)',
    );
  }

  async schedule(roomId: string, threadId: string | null, due: number, text: string): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || due < currentAlarm) await this.ctx.storage.setAlarm(due);
    this.ctx.storage.sql.exec(
      'INSERT INTO reminders (due, room_id, thread_id, text) VALUES (?, ?, ?, ?)',
      due,
      roomId,
      threadId,
      text,
    );
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const rows = sql
      .exec<{ id: number; room_id: string; thread_id: string | null; text: string; attempts: number }>(
        'SELECT id, room_id, thread_id, text, attempts FROM reminders WHERE due <= ? ORDER BY due',
        now,
      )
      .toArray();
    const bot = getBot(this.env);

    for (const row of rows) {
      try {
        await bot.deliverReminder(row.room_id, row.thread_id, row.text);
        sql.exec('DELETE FROM reminders WHERE id = ?', row.id);
      } catch (error) {
        console.error('reminder delivery failed:', error);
        if (row.attempts + 1 >= REMINDER_MAX_ATTEMPTS) {
          sql.exec('DELETE FROM reminders WHERE id = ?', row.id);
        } else {
          sql.exec(
            'UPDATE reminders SET attempts = attempts + 1, due = ? WHERE id = ?',
            now + REMINDER_RETRY_MS,
            row.id,
          );
        }
      }
    }

    await this.scheduleNext();
  }

  private async scheduleNext(): Promise<void> {
    const { next_due } = this.ctx.storage.sql
      .exec<{ next_due: number | null }>('SELECT MIN(due) AS next_due FROM reminders')
      .one();
    if (next_due === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next_due);
  }
}

export class MatrixBot extends MatrixBotDO {
  protected override async shouldJoinRoom(roomId: string, inviter: string): Promise<boolean> {
    if (!BOT_ADMINS.has(inviter)) {
      console.log(`Rejected invite to ${roomId} from unauthorized user: ${inviter}`);
      return false; // leaves the invite pending
    }
    console.log(`Accepted invite to ${roomId} from trusted user: ${inviter}`);
    return true;
  }

  async deliverReminder(roomId: string, threadId: string | null, text: string): Promise<void> {
    await this.ensureStarted();
    await this.sendNotice(roomId, `\u23f0 reminder: ${text}`, { threadId: threadId ?? undefined });
  }

  private async clearRoom(roomId: string): Promise<void> {
    if (clearing.has(roomId)) return;
    clearing.add(roomId);
    try {
      const userId = this.client.getUserId();
      const accessToken = this.client.getAccessToken();
      if (!userId || !accessToken) return;
      await deleteBotMessages(this.client.getHomeserverUrl().replace(/\/+$/, ''), accessToken, userId, roomId);
    } finally {
      clearing.delete(roomId);
    }
  }

  protected override async onMessage(message: BotMessage): Promise<void> {
    if (message.msgtype !== 'm.text') return;

    const [prefix = '', subcommand = '', ...args] = (message.body ?? '').trim().split(/\s+/);
    if (prefix.toLowerCase() !== COMMAND_PREFIX) return;
    const command = subcommand.toLowerCase();

    const { roomId } = message;
    const threadId = message.threadRootId;

    // Admin-only mute switch. Handled before the cooldown and mute checks so it always
    // works, even while the room is being spammed.
    if (command === 'mute' || command === 'unmute') {
      if (!BOT_ADMINS.has(message.sender)) return;
      await setRoomMuted(this.ctx.storage, roomId, command === 'mute');
      return;
    }

    if (command === 'clear') {
      if (BOT_ADMINS.has(message.sender)) await this.clearRoom(roomId).catch(() => undefined);
      return;
    }

    // Single cooldown for every command: at most one reply per room per second.
    if (!acquireCooldown(roomId)) return;

    // Muted rooms get no replies at all.
    if (await isRoomMuted(this.ctx.storage, roomId)) return;

    // Bare "!faith" or a mistyped/unknown subcommand: show the help text.
    if (!KNOWN_COMMANDS.has(command)) {
      await this.sendNotice(roomId, HELP_TEXT, { threadId }).catch(() => undefined);
      return;
    }

    if (args.length > 0 && command !== 'remind') return;

    if (command === 'inspire') {
      try {
        const image = await fetchInspiroImage();
        await this.sendFile(roomId, image.bytes, {
          filename: image.filename,
          mimetype: image.mimetype,
          msgtype: 'm.image',
          body: image.filename,
          threadId,
        });
      } catch (error) {
        console.error('inspire command failed:', error);
        await this.sendNotice(roomId, "Couldn't generate the image.", { threadId }).catch(() => undefined);
      }
      return;
    }

    const env = this.env as unknown as Env;
    let run: () => string | Promise<string>;
    switch (command) {
      case 'help':
        run = () => HELP_TEXT;
        break;
      case 'catfact':
        run = fetchCatFact;
        break;
      case 'meow':
        run = () => fetchMeow(env.MEOW_BASE_URL);
        break;
      case 'remind':
        run = () => createReminder(env, roomId, threadId ?? null, args);
        break;
      default:
        return;
    }

    try {
      await this.sendNotice(roomId, await run(), { threadId });
    } catch (error) {
      console.error(`${command} command failed:`, error);
      await this.sendNotice(roomId, errorMessage(error), { threadId }).catch(() => undefined);
    }
  }
}

interface Env {
  BOT_DO: DurableObjectNamespace<MatrixBot>;
  REMINDER_DO: DurableObjectNamespace<ReminderStore>;
  MATRIX_PASSWORD?: string;
  MATRIX_PROVISION_CRYPTO?: string;
  MATRIX_RECOVERY_PASSPHRASE?: string;
  MATRIX_RECOVERY_KEY?: string;
  MEOW_BASE_URL?: string;
}

function getBot(env: Env) {
  return env.BOT_DO.get(env.BOT_DO.idFromName(BOT_INSTANCE_NAME));
}

function missingSecrets(env: Env): string[] {
  const missing: string[] = [];
  if (!env.MATRIX_PASSWORD) missing.push('MATRIX_PASSWORD');
  const flag = env.MATRIX_PROVISION_CRYPTO;
  const provision = flag !== undefined && flag !== '' && flag !== 'false' && flag !== '0';
  if (provision && !env.MATRIX_RECOVERY_PASSPHRASE && !env.MATRIX_RECOVERY_KEY) {
    missing.push('MATRIX_RECOVERY_PASSPHRASE');
  }
  return missing;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/') {
      return new Response('Not found', { status: 404 });
    }

    const missing = missingSecrets(env);
    if (missing.length > 0) {
      console.error('missing secrets:', missing.join(', '));
      return Response.json({ ok: false, error: 'missing_configuration' }, { status: 500 });
    }

    try {
      const result = await getBot(env).ensureStarted();
      return Response.json({ ok: true, started: result.started });
    } catch (error) {
      console.error('bot failed to start:', error);
      return Response.json({ ok: false, error: 'start_failed' }, { status: 500 });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (missingSecrets(env).length > 0) return;
    try {
      await getBot(env).ensureStarted();
    } catch (error) {
      console.error('scheduled start failed:', error);
    }
  },
};
