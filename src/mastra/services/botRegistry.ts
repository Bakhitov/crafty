import { TelegramIntegration } from "../integrations/telegramN8nTeam";
import { env } from "../config/environment";

export type BotRecord = {
  id: string;
  channel: "telegram";
  agentName: string;
  displayName?: string;
  // Telegram
  telegramToken?: string;
};

/**
 * Simple in-memory registry. In production, back this with DB table (e.g. telegram_bots/whatsapp_bots).
 */
export class BotRegistry {
  private tgBots = new Map<string, TelegramIntegration>();
  private readonly records: BotRecord[] = [];
  private readonly resolveAgent?: (name: string) => any;

  constructor(options?: { resolveAgent?: (name: string) => any }) {
    this.resolveAgent = options?.resolveAgent;
    // Seed from env for now (Telegram real, WhatsApp stub)
    if (env.telegram.botToken) {
      this.records.push({
        id: "tg-default",
        channel: "telegram",
        agentName: "orchestratorAgent",
        displayName: "Telegram Default",
        telegramToken: env.telegram.botToken,
      });
    }
  }

  list(): BotRecord[] { return [...this.records]; }

  async startAll(): Promise<void> {
    for (const rec of this.records) {
      if (rec.channel === "telegram" && rec.telegramToken) {
        const bot = new TelegramIntegration(rec.telegramToken, { agentName: rec.agentName, resolveAgent: this.resolveAgent });
        this.tgBots.set(rec.id, bot);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [_, bot] of this.tgBots) await bot.cleanup();
    this.tgBots.clear();
  }
}


