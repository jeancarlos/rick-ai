import type { Connector, IncomingMessage, OnMessageCallback, OnPollVoteCallback, SendMessageOptions } from "./types.js";
import { logger } from "../config/logger.js";

/**
 * Manages multiple connectors and routes messages between them and the Agent.
 *
 * The ConnectorManager is the glue between connectors and the Agent core.
 * It provides the Agent with a connector-agnostic way to send messages
 * back to users, and gives connectors a way to forward incoming messages
 * to the Agent.
 *
 * Usage:
 *   const manager = new ConnectorManager();
 *   manager.onMessage(async (msg) => agent.handleMessage(...));
 *   manager.onPollVote(async (userId, options) => agent.handlePollVote(...));
 *   manager.register(whatsappConnector);
 *   manager.register(webConnector);
 *   await manager.startAll();
 */
export class ConnectorManager {
  private connectors = new Map<string, Connector>();
  private messageHandler: OnMessageCallback | null = null;
  private pollVoteHandler: OnPollVoteCallback | null = null;

  /**
   * Register a message handler. Called by the Agent during bootstrap.
   * When any connector receives a message, this handler is invoked.
   */
  onMessage(handler: OnMessageCallback): void {
    this.messageHandler = handler;
  }

  /**
   * Register a poll vote handler. Called by the Agent during bootstrap.
   */
  onPollVote(handler: OnPollVoteCallback): void {
    this.pollVoteHandler = handler;
  }

  /**
   * Register a connector. Does not start it — call startAll() for that.
   */
  register(connector: Connector): void {
    if (this.connectors.has(connector.name)) {
      throw new Error(`Connector "${connector.name}" already registered`);
    }
    this.connectors.set(connector.name, connector);
    logger.info({ connector: connector.name, capabilities: connector.capabilities }, "Connector registered");
  }

  /**
   * Get a connector by name.
   */
  get(name: string): Connector | undefined {
    return this.connectors.get(name);
  }

  /**
   * Get all registered connectors.
   */
  getAll(): Connector[] {
    return [...this.connectors.values()];
  }

  /**
   * Start all registered connectors.
   */
  async startAll(): Promise<void> {
    for (const connector of this.connectors.values()) {
      try {
        await connector.start();
        logger.info({ connector: connector.name }, "Connector started");
      } catch (err) {
        logger.error({ err, connector: connector.name }, "Failed to start connector");
        throw err;
      }
    }
  }

  /**
   * Stop all registered connectors.
   */
  async stopAll(): Promise<void> {
    for (const connector of this.connectors.values()) {
      try {
        await connector.stop();
        logger.info({ connector: connector.name }, "Connector stopped");
      } catch (err) {
        logger.warn({ err, connector: connector.name }, "Failed to stop connector");
      }
    }
  }

  // ==================== INBOUND (Connector → Agent) ====================

  /**
   * Called by connectors when they receive a message from the user.
   * Routes the message to the registered handler (Agent).
   * Returns the Agent's response text.
   */
  async handleIncomingMessage(msg: IncomingMessage): Promise<string> {
    if (!this.messageHandler) {
      logger.warn({ connector: msg.connectorName }, "No message handler registered — dropping message");
      return "Erro interno: handler de mensagens nao registrado.";
    }
    return this.messageHandler(msg);
  }

  /**
   * Called by connectors when they receive a poll vote from the user.
   * Routes the vote to the registered handler (Agent).
   */
  async handlePollVote(userId: string, selectedOptions: string[]): Promise<void> {
    if (!this.pollVoteHandler) {
      logger.warn("No poll vote handler registered — dropping vote");
      return;
    }
    await this.pollVoteHandler(userId, selectedOptions);
  }

  // ==================== OUTBOUND (Agent → Connector) ====================

  /**
   * Send a message to a user via a specific connector.
   * Used by the Agent to send responses, sub-agent output, etc.
   *
   * @param options - Optional metadata (e.g., sessionId for sub-agent routing on Web UI).
   */
  async sendMessage(connectorName: string, userId: string, text: string, options?: SendMessageOptions): Promise<void> {
    const connector = this.connectors.get(connectorName);
    if (!connector) {
      logger.warn({ connectorName, userId }, "Connector not found — cannot send message");
      return;
    }
    await connector.sendMessage(userId, text, options);
  }

  /**
   * Send a poll to a user via a specific connector.
   * Falls back to a text message listing the options if the connector doesn't support polls.
   *
   * @param msgOptions - Optional metadata (e.g., sessionId for sub-agent routing on Web UI).
   */
  async sendPoll(connectorName: string, userId: string, question: string, options: string[], msgOptions?: SendMessageOptions): Promise<void> {
    const connector = this.connectors.get(connectorName);
    if (!connector) {
      logger.warn({ connectorName, userId }, "Connector not found — cannot send poll");
      return;
    }

    if (connector.capabilities.polls && connector.sendPoll) {
      await connector.sendPoll(userId, question, options);
    } else {
      // Fallback: send as text with numbered options (preserving sessionId metadata)
      const optionList = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
      await connector.sendMessage(userId, `*${question}*\n\n${optionList}\n\n_Responda com o numero da opcao._`, msgOptions);
    }
  }

  /**
   * Set typing indicator on a specific connector.
   * Silently ignored if the connector doesn't support it.
   */
  async setTyping(connectorName: string, userId: string, composing: boolean): Promise<void> {
    const connector = this.connectors.get(connectorName);
    if (!connector || !connector.capabilities.typing || !connector.setTyping) return;

    await connector.setTyping(userId, composing).catch((err) => {
      logger.warn({ err, connectorName }, "Failed to set typing indicator");
    });
  }

  /**
   * Broadcast a message to a user across ALL connectors.
   * Used for critical notifications (e.g., "Rick is restarting").
   */
  async broadcast(userId: string, text: string): Promise<void> {
    for (const connector of this.connectors.values()) {
      await connector.sendMessage(userId, text).catch((err) => {
        logger.warn({ err, connector: connector.name }, "Broadcast send failed");
      });
    }
  }
}
