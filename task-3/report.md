# Development Report — Learner Telegram Bot

## Overview

Learner Telegram Bot is an AI-powered Telegram learning bot built entirely in n8n. It lets users submit URLs to study, generates structured summaries with key points, and quizzes users on saved materials with multiple-choice questions. The bot stores all data in Google Sheets and uses OpenAI (gpt-4o) for content analysis and quiz generation.

The final workflow contains **45 nodes**: 15 Telegram, 11 Code, 7 Google Sheets, 4 Switch, 3 IF, 2 HTTP Request, 2 OpenAI, and 1 Telegram Trigger.

---

## Tools and Techniques Used

### n8n (Workflow Automation Platform)
The entire bot is implemented as a single n8n workflow. I started by building a few small flows manually in the n8n UI to learn how nodes connect, how expressions work, and how the Telegram integration behaves. This hands-on exploration was essential for understanding n8n's data model before scaling up.

### VS Code + GitHub Copilot Agent
After learning the basics in the n8n UI, I exported the workflow JSON and switched to editing it directly with the help of an AI coding agent. The agent iteratively modified the JSON configuration — adding nodes, connections, and logic — while validating the output with Python scripts. This approach was significantly faster than clicking through the UI for 45 nodes.

### Context7 MCP (n8n Documentation)
To validate and improve the AI-generated JSON, I used the Context7 MCP server to pull up-to-date n8n documentation and node definitions. This was critical for getting node parameter structures right, especially for the Telegram node's inline keyboard format (`fixedCollection` with `rows → row → buttons`).

### Google Sheets API
Used as the primary data store via n8n's native Google Sheets nodes. All materials, summaries, quiz questions, quiz state, and scores are stored in a single sheet with columns for each data type.

### OpenAI API (gpt-4o)
Two AI-powered nodes:
- **Learn_GetMaterials_Analyze**: Analyzes fetched web page content and produces structured summaries with title, key points, and difficulty rating.
- **Quiz_GenerateQuestions**: Generates 5 multiple-choice questions from the material summary for quiz mode.

The initial implementation used `gpt-4o-mini` for cost efficiency. After reviewing the available OpenAI model options — including `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`, `o3-mini`, and `o4-mini` — `gpt-4o` was selected as the best balance of quality and availability. It produces significantly better structured JSON output for summaries and more accurate, contextually relevant quiz questions, while still being supported by the n8n free OpenAI API credits.

### Python (Validation Scripts)
Used Python one-liners in the terminal to validate JSON structure, check for misplaced parameters, and verify fixes across all nodes. This was faster and more reliable than manual inspection of a 1800+ line JSON file.

---

## What Worked

1. **AI-assisted JSON editing** — Having the agent modify the workflow JSON directly was highly productive. The workflow grew from a few nodes to 45 nodes with complex routing logic for commands, callbacks, quiz state management, and answer processing.

2. **Iterative validation** — Running Python validation scripts after each change caught issues early. For example, verifying that all Telegram nodes had `appendAttribution` at the correct parameter level, or that inline keyboards used `buttons` instead of `values`.

3. **Context7 MCP for n8n source code** — When the AI generated incorrect node configurations, pulling the actual n8n source code (Telegram.node.ts, GenericFunctions.ts) revealed the exact parameter structures expected. This resolved the "Could not find property option" import error.

4. **Google Sheets as storage** — Choosing Google Sheets as the data store was pragmatic: it's free, has a native n8n integration, and is easy to inspect/debug by opening the spreadsheet directly.

5. **Quiz state persistence** — The quiz flow handles resume (pick up where you left off), restart (same questions, fresh attempt), completed detection (show previous score), and new generation seamlessly through a single `Quiz_CheckExisting` Code node.

---

## What Did Not Work

1. **Inline keyboard with dynamic options** — The default n8n Telegram node uses a `fixedCollection` parameter for inline keyboards, which requires a static number of rows defined at design time. For the material selection keyboard (where the number of materials varies per user), this approach was impossible. I had to fall back to an HTTP Request node calling the Telegram API directly, which required hardcoding the bot token in the URL. I explored `predefinedCredentialType`, `$vars`, and `$env` alternatives, but none could inject the token into the URL path for Telegram's auth scheme. This was frustrating but unavoidable.

2. **`appendAttribution` parameter placement** — The AI initially placed `appendAttribution: false` inside the `additionalFields` collection. In n8n's Telegram node v1.2, this is actually a top-level parameter. When misplaced, n8n silently defaulted to `true`, appending attribution text and forcing Markdown parse mode — which broke messages containing `[url]` syntax. This caused cryptic "Bad Request: can't parse entities" errors from the Telegram API at byte offset 380.

3. **`values` vs `buttons` in fixedCollection** — The AI used `values` as the key name for inline keyboard button arrays, but n8n's fixedCollection definition uses `name: 'buttons'`. This caused a "Could not find property option" error on import. Only resolved after reading the actual n8n source code on GitHub.

4. **n8n node parameter discovery** — n8n's documentation doesn't always show the exact JSON structure expected for complex parameter types (fixedCollection, collections with nested options). The AI had to infer structures, leading to trial-and-error. The Context7 MCP and direct GitHub source reading were essential workarounds.

---

## Notable Decisions

### Google Sheets as the Data Store
Chose Google Sheets over a database because: it's free, has a mature n8n integration (read, write, update, lookup), is easy to inspect and debug, and doesn't require any infrastructure setup. The trade-off is limited scalability and no indexing, but for a learning bot with per-user materials, this is more than sufficient.

### Single Workflow Architecture
The entire bot — `/start`, `/learn`, `/quiz`, callback handling, quiz state machine, answer processing — lives in one n8n workflow with 45 nodes. This keeps deployment simple (one JSON import) but makes the workflow visually complex. A multi-workflow approach with sub-workflows could improve maintainability.

### HTTP Request for Dynamic Keyboard
For the material selection menu (which varies per user), the native Telegram node's static inline keyboard wasn't viable. Switched to an HTTP Request node calling `sendMessage` directly with a dynamically built `reply_markup`. This is the only node with a hardcoded bot token — all other Telegram nodes use n8n's credential system.

### Quiz State Machine in Code Nodes
Quiz state management (new/in-progress/completed) is handled in Code nodes rather than with additional n8n flow nodes. This keeps the logic readable in one place (`Quiz_CheckExisting`) rather than spread across multiple IF/Switch nodes, at the cost of being less visual.

### Previous Score Display on Retake
When a user selects a material they've already completed a quiz on, the bot shows their previous score with an encouraging message before starting a fresh quiz. Perfect scores get "Can you repeat your success?" while lower scores get "Try to beat your record!" This adds a gamification element without adding new nodes — just conditional logic in `Quiz_FormatResume`.
