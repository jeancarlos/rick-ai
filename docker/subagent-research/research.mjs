/**
 * Research sub-agent script.
 *
 * TWO MODES:
 * 1. Web Search: Gemini Pro + Google Search grounding (for public info)
 * 2. Browser Automation: Gemini Pro agentic loop with Playwright (for authenticated tasks)
 *
 * The agent decides which actions to take by looking at page snapshots.
 * No hardcoded selectors — the LLM uses accessibility snapshots to navigate.
 *
 * Usage: node research.mjs "search query or question"
 * Requires: GEMINI_API_KEY env var
 */

import { chromium } from "playwright";
import { createHmac } from "crypto";

const query = process.argv[2];
if (!query) {
  console.error("Usage: node research.mjs <query>");
  process.exit(1);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("ERROR: GEMINI_API_KEY not set");
  process.exit(1);
}

const model = process.env.GEMINI_MODEL || "gemini-3.1-pro-preview";

// ==== TOTP generation ====

function generateTOTP(secret) {
  try {
    const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const c of secret.toUpperCase()) {
      const val = base32chars.indexOf(c);
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, "0");
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.substring(i, i + 8), 2));
    }
    const keyBuffer = Buffer.from(bytes);
    const time = Math.floor(Date.now() / 1000 / 30);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeUInt32BE(Math.floor(time / 0x100000000), 0);
    timeBuffer.writeUInt32BE(time & 0xffffffff, 4);
    const hmac = createHmac("sha1", keyBuffer);
    hmac.update(timeBuffer);
    const hash = hmac.digest();
    const offset = hash[hash.length - 1] & 0xf;
    const code =
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff);
    return (code % 1000000).toString().padStart(6, "0");
  } catch (err) {
    console.error(`[TOTP] Error: ${err.message}`);
    return null;
  }
}

// ==== Credential parsing ====

function parseCredentials(text) {
  const creds = {};
  const block = text.match(/--- CREDENCIAIS DISPONIVEIS ---\n([\s\S]*?)\n--- FIM CREDENCIAIS ---/);
  if (!block) return creds;
  const lines = block[1].split("\n");
  for (const line of lines) {
    const m = line.match(/\[Credencial\s+(\w+)\]:\s*(.*)/i);
    if (m) creds[m[1].toLowerCase()] = m[2].trim();
  }
  return creds;
}

function needsBrowserAutomation(queryText, credentials) {
  if (Object.keys(credentials).length === 0) return false;
  const emailKeywords = /e-?mail|inbox|caixa\s*de?\s*entrada|nao\s*lid|n[aã]o\s*lid|unread|mensage[nm]/i;
  const accountKeywords = /acessa|entra|verifica|checa|abre|login|loga/i;
  const hasEmailCred = credentials.outlook || credentials.gmail || credentials.hotmail || credentials.email;
  if (hasEmailCred && emailKeywords.test(queryText)) return true;
  if (accountKeywords.test(queryText) && Object.keys(credentials).length > 0) return true;
  // Follow-up: if this is a session continuation with credentials, use browser
  if (/CONTEXTO DA SESSAO ANTERIOR/.test(queryText) && Object.keys(credentials).length > 0) return true;
  return false;
}

// ==== Gemini API helper (raw REST, supports function calling) ====

async function geminiCall(contents, systemInstruction, tools, toolConfig) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = { contents, generationConfig: { temperature: 0.3, maxOutputTokens: 8192 } };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (tools) body.tools = tools;
  if (toolConfig) body.toolConfig = toolConfig;
  const payload = JSON.stringify(body);

  // Retry with exponential backoff for transient errors (429, 503)
  for (let attempt = 0; attempt < 4; attempt++) {
    // 60s timeout per attempt
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);

    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: controller.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === "AbortError") {
        if (attempt < 3) {
          console.error(`[Gemini] timeout — retrying (attempt ${attempt + 1}/3)`);
          continue;
        }
        throw new Error("Gemini API timeout after 60s (all retries exhausted)");
      }
      throw fetchErr;
    }
    clearTimeout(timeoutId);

    if (resp.ok) return await resp.json();

    const status = resp.status;
    if ((status === 429 || status === 503) && attempt < 3) {
      const wait = (attempt + 1) * 3000; // 3s, 6s, 9s
      console.error(`[Gemini] ${status} — retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const err = await resp.text();
    throw new Error(`Gemini ${status}: ${err.substring(0, 300)}`);
  }
  // Safety net — should never reach here, but prevents returning undefined
  throw new Error("Gemini API: all retry attempts exhausted without response");
}

// ==== Browser automation: agentic loop ====

const BROWSER_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "navigate",
        description: "Navigate the browser to a URL",
        parameters: {
          type: "OBJECT",
          properties: { url: { type: "STRING", description: "URL to navigate to" } },
          required: ["url"],
        },
      },
      {
        name: "click",
        description: "Click an element on the page. Use the accessible name from the snapshot.",
        parameters: {
          type: "OBJECT",
          properties: {
            role: { type: "STRING", description: "ARIA role: button, link, textbox, menuitem, option, etc." },
            name: { type: "STRING", description: "Accessible name of the element (from the snapshot)" },
          },
          required: ["role", "name"],
        },
      },
      {
        name: "fill",
        description: "Type/fill text into an input field. Use the accessible name from the snapshot.",
        parameters: {
          type: "OBJECT",
          properties: {
            role: { type: "STRING", description: "ARIA role (usually 'textbox')" },
            name: { type: "STRING", description: "Accessible name of the input" },
            value: { type: "STRING", description: "Text to type into the field" },
          },
          required: ["role", "value"],
        },
      },
      {
        name: "press_key",
        description: "Press a keyboard key (Enter, Tab, Escape, etc.)",
        parameters: {
          type: "OBJECT",
          properties: { key: { type: "STRING", description: "Key name" } },
          required: ["key"],
        },
      },
      {
        name: "get_totp_code",
        description: "Generate a TOTP 6-digit code from a base32 secret key (for 2FA/MFA authenticator). Returns the current valid code.",
        parameters: {
          type: "OBJECT",
          properties: { secret: { type: "STRING", description: "Base32-encoded TOTP secret key (spaces will be removed)" } },
          required: ["secret"],
        },
      },
      {
        name: "snapshot",
        description: "Get the current page accessibility tree (YAML). Use this to see what's on the page after actions.",
        parameters: { type: "OBJECT", properties: {} },
      },
      {
        name: "wait",
        description: "Wait for a specified number of seconds (useful for pages loading)",
        parameters: {
          type: "OBJECT",
          properties: { seconds: { type: "NUMBER", description: "Seconds to wait (1-10)" } },
          required: ["seconds"],
        },
      },
      {
        name: "done",
        description: "The task is complete. Return the final result/summary to the user.",
        parameters: {
          type: "OBJECT",
          properties: { result: { type: "STRING", description: "Final result to show the user (in pt-BR, formatted for WhatsApp)" } },
          required: ["result"],
        },
      },
    ],
  },
];

/**
 * Get the active page from the context. After login redirects, the original
 * page may close and a new one opens. Always use the latest page.
 */
function getActivePage(context) {
  const pages = context.pages();
  return pages[pages.length - 1] || null;
}



async function executeBrowserTool(context, name, args) {
  const page = getActivePage(context);
  if (!page && name !== "done" && name !== "get_totp_code") {
    return `Error: no active page (browser may have closed). Try navigate to reopen.`;
  }

  try {
    switch (name) {
      case "navigate":
        await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(1000);
        return `Navigated to ${args.url}. Current URL: ${page.url()}`;

      case "click": {
        const locator = args.name
          ? page.getByRole(args.role, { name: args.name })
          : page.getByRole(args.role).first();
        await locator.click({ timeout: 10000 });
        // After click, wait for potential navigation/new page
        await page.waitForTimeout(2000);
        // Check if we're on a new page now
        const activePage = getActivePage(context);
        return `Clicked ${args.role} "${args.name || ""}". Current URL: ${activePage?.url() || "(page closed)"}`;
      }

      case "fill": {
        const locator = args.name
          ? page.getByRole(args.role, { name: args.name })
          : page.getByRole(args.role).first();
        await locator.fill(args.value, { timeout: 10000 });
        return `Filled ${args.role} "${args.name || ""}" with text`;
      }

      case "press_key":
        await page.keyboard.press(args.key);
        await page.waitForTimeout(500);
        return `Pressed ${args.key}`;

      case "get_totp_code": {
        const clean = (args.secret || "").replace(/\s+/g, "").toUpperCase();
        const code = generateTOTP(clean);
        return code ? `TOTP code: ${code}` : "Failed to generate TOTP code — check the secret key";
      }

      case "snapshot": {
        const snap = await page.locator("body").ariaSnapshot({ timeout: 8000 }).catch(async () => {
          // Fallback: try the active page (might have changed)
          const p = getActivePage(context);
          if (p && p !== page) return await p.locator("body").ariaSnapshot({ timeout: 5000 }).catch(() => null);
          return null;
        });
        if (snap) {
          return snap.length > 8000 ? snap.substring(0, 8000) + "\n... (truncated)" : snap;
        }
        // Last fallback: page text
        try {
          const p = getActivePage(context);
          const text = await p.evaluate(() => document.body.innerText?.substring(0, 4000) || "");
          return `[Snapshot fallback - page text]: ${text}`;
        } catch {
          return "[Snapshot failed - no accessible page]";
        }
      }

      case "wait": {
        const ms = Math.min(Math.max((args.seconds || 1) * 1000, 500), 10000);
        await page.waitForTimeout(ms).catch(() => {});
        const p = getActivePage(context);
        return `Waited ${ms / 1000}s. Current URL: ${p?.url() || "(unknown)"}`;
      }

      case "done":
        return null; // Signal to break

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    // If page closed during action, try to recover
    if (err.message.includes("closed") || err.message.includes("Target")) {
      const newPage = getActivePage(context);
      if (newPage) {
        return `Action may have caused page navigation. New active page URL: ${newPage.url()}. Use snapshot to see the current state.`;
      }
      // No pages — create new one
      const freshPage = await context.newPage();
      return `Page was closed. Created new page. Use navigate to go somewhere.`;
    }
    return `Error executing ${name}: ${err.message}`;
  }
}

async function runBrowserAgent(task, credentials) {
  console.error("[Agent] Starting browser automation agent");

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      locale: "pt-BR",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    // Listen for new pages (popups, redirects that open new tabs)
    context.on("page", (newPage) => {
      console.error(`[Agent] New page opened: ${newPage.url()}`);
    });

    // Build credential context for the agent
    const credBlock = Object.entries(credentials)
      .map(([svc, val]) => `${svc}: ${val}`)
      .join("\n");

    const systemPrompt = `Voce e um agente de automacao de browser. Voce controla um browser real via Playwright.

TAREFA DO USUARIO: ${task}

CREDENCIAIS DISPONIVEIS:
${credBlock}

INSTRUCOES:
1. Use a ferramenta 'navigate' para ir a sites.
2. Use 'snapshot' para ver o conteudo acessivel da pagina (YAML com roles e nomes).
3. Use 'click' e 'fill' com o role e name EXATOS do snapshot para interagir.
4. Use 'get_totp_code' quando precisar de um codigo TOTP/2FA — passe a chave do autenticador.
5. Use 'wait' se a pagina precisar de tempo para carregar.
6. Use 'done' com o resultado final quando terminar.

REGRAS:
- Seja eficiente: faca snapshot apenas quando precisar confirmar estado, nao obrigatoriamente apos toda acao.
- Pense em custo/beneficio: maximize informacao por acao e minimize cliques.
- Nao faca scraping burro. Evite loops de navegacao (setas, rolagem, abrir item por item) quando isso nao for estritamente necessario.
- Para listas, entregue primeiro um resumo objetivo (total + top 3 a 5 itens). So detalhar item a item quando o usuario pedir explicitamente todos os detalhes.
- Se perceber que esta entrando em tentativa e erro repetitiva, pare e finalize com o melhor resumo confiavel obtido + diga qual recorte objetivo o usuario pode pedir em seguida.
- Nos campos de senha e TOTP, preencha e clique no botao de submit.
- Se a pagina pedir autenticacao de dois fatores e voce tiver a chave TOTP, use 'get_totp_code' para gerar o codigo.
- Se houver opcoes de metodo de login (ex: "Use your password" vs "Authenticator app"), escolha usar senha.
- Se uma acao retornar que a pagina foi fechada ou navegou, faca 'snapshot' para ver o estado atual.
- Responda sempre em portugues brasileiro.
- Formate a resposta final para WhatsApp (*negrito*, _italico_).
- Seja conciso e direto na resposta final.
- NAO invente informacoes — retorne apenas o que voce realmente viu na pagina.
- Se algo der errado, explique o erro na resposta 'done'.
- Se a tarefa incluir "CONTEXTO DA SESSAO ANTERIOR", isso significa que o usuario esta dando continuidade a uma tarefa ja feita. Use o "Resultado anterior" para entender o que ja foi feito e atenda a "Nova instrucao do usuario". Voce precisa refazer o login se necessario (browser e novo), mas foque no que o usuario esta pedindo agora.`;

    // Start with initial snapshot
    const initialSnap = await page.locator("body").ariaSnapshot().catch(() => "(pagina em branco)");

    const messages = [
      {
        role: "user",
        parts: [{ text: `Comece a tarefa. Pagina atual (about:blank):\n${initialSnap}` }],
      },
    ];

    const MAX_STEPS = 60;
    for (let step = 0; step < MAX_STEPS; step++) {
      console.error(`[Agent] Step ${step + 1}/${MAX_STEPS}`);

      const data = await geminiCall(messages, systemPrompt, BROWSER_TOOLS);

      const candidate = data.candidates?.[0];
      if (!candidate?.content?.parts) {
        console.error("[Agent] No response from Gemini");
        break;
      }

      // Add model response to history
      messages.push({ role: "model", parts: candidate.content.parts });

      // Find function calls
      const fnCalls = candidate.content.parts.filter((p) => p.functionCall);
      if (fnCalls.length === 0) {
        // Model gave text instead of tool call — extract as result
        const textParts = candidate.content.parts.filter((p) => p.text);
        const result = textParts.map((p) => p.text).join("\n");
        console.error(`[Agent] Model returned text: ${result.substring(0, 100)}`);
        await browser.close();
        return result || "(sem resultado)";
      }

      // Execute each function call
      const fnResponses = [];
      for (const part of fnCalls) {
        const { name, args } = part.functionCall;
        console.error(`[Agent] Tool: ${name}(${JSON.stringify(args).substring(0, 100)})`);

        const result = await executeBrowserTool(context, name, args || {});

        if (result === null) {
          // done() was called
          const finalResult = args.result || "(tarefa concluida)";
          console.error(`[Agent] Done: ${finalResult.substring(0, 100)}`);
          await browser.close();
          return finalResult;
        }

        fnResponses.push({
          functionResponse: { name, response: { content: result } },
        });

        console.error(`[Agent] Result: ${String(result).substring(0, 150)}`);
      }

      // Send tool results back
      messages.push({ role: "user", parts: fnResponses });
    }

    console.error("[Agent] Max steps reached");
    await browser.close();
    return "Atingi o limite de passos sem completar a tarefa. Tente novamente com instrucoes mais especificas.";

  } catch (err) {
    console.error(`[Agent] Fatal error: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return `Erro no agente de browser: ${err.message}`;
  }
}

// ==== Web search (Gemini + Google Search grounding) ====

function extractUrls(text) {
  const urlRegex = /https?:\/\/[^\s,)}\]>"']+/gi;
  return [...new Set(text.match(urlRegex) || [])];
}

async function fetchUrlContent(url) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; ZapAgent/1.0)",
    Accept: "text/plain, text/html, application/json, */*",
  };
  try {
    const resp = await fetch(url, { headers, redirect: "follow" });
    if (!resp.ok) return { url, content: `[HTTP ${resp.status}]`, type: "error" };
    const contentType = resp.headers.get("content-type") || "";
    const body = await resp.text();
    if (contentType.includes("html")) {
      const text = body
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { url, content: text.substring(0, 15000), type: "html" };
    }
    return { url, content: body.substring(0, 15000), type: "text" };
  } catch (err) {
    return { url, content: `[Erro: ${err.message}]`, type: "error" };
  }
}

async function webSearch(prompt, urlContents) {
  let contextBlock = "";
  if (urlContents.length > 0) {
    contextBlock = "\n\n--- CONTEUDO DAS URLs ---\n";
    for (const uc of urlContents) {
      contextBlock += `\n[${uc.url}] (${uc.type})\n${uc.content}\n`;
    }
    contextBlock += "\n--- FIM ---\n";
  }

  const systemPrompt = `Voce e um assistente de pesquisa. Retorne resultados detalhados e precisos em portugues brasileiro.
Regras: cite fontes, seja organizado, use formatacao WhatsApp (*negrito*, _italico_), foque em info recente.`;

  const data = await geminiCall(
    [{ role: "user", parts: [{ text: prompt + contextBlock }] }],
    systemPrompt,
    [{ googleSearch: {} }]
  );

  let output = "";
  if (data.candidates?.[0]?.content?.parts) {
    for (const part of data.candidates[0].content.parts) {
      if (part.text) output += part.text;
    }
  }

  const grounding = data.candidates?.[0]?.groundingMetadata;
  if (grounding?.groundingChunks?.length > 0) {
    output += "\n\n*Fontes:*\n";
    const seen = new Set();
    for (const chunk of grounding.groundingChunks) {
      if (chunk.web?.uri && !seen.has(chunk.web.uri)) {
        seen.add(chunk.web.uri);
        output += `- ${chunk.web.title || chunk.web.uri}: ${chunk.web.uri}\n`;
      }
    }
  }

  return output;
}

// ==== Entry point ====

try {
  const credentials = parseCredentials(query);
  const credServices = Object.keys(credentials);
  if (credServices.length > 0) {
    console.error(`[Research] Credentials for: ${credServices.join(", ")}`);
  }

  if (needsBrowserAutomation(query, credentials)) {
    console.error("[Research] → Browser automation mode");
    const result = await runBrowserAgent(query, credentials);
    console.log(result);
  } else {
    console.error("[Research] → Web search mode");
    const urls = extractUrls(query);
    let urlContents = [];
    if (urls.length > 0) {
      console.error(`Fetching ${urls.length} URL(s)`);
      urlContents = await Promise.all(urls.map(fetchUrlContent));
    }
    const result = await webSearch(query, urlContents);
    console.log(result);
  }
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
