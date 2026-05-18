# Learner Telegram Bot — Setup & Usage Guide

An AI-powered Telegram bot for learning from web articles. Submit URLs to get structured summaries, then quiz yourself on the material.

## Prerequisites

- **n8n** instance (self-hosted or cloud) — [n8n.io](https://n8n.io)
- **Telegram Bot** — create one via [@BotFather](https://t.me/BotFather)
- **Google account** — for Google Sheets storage
- **OpenAI API key** — for content analysis and quiz generation

## Setup

### 1. Prepare Google Sheets

1. Create a new Google Spreadsheet.
2. Name the first sheet tab **Materials**.
3. Add these column headers in row 1:

   | id | url | userId | chatId | title | content | summaryJSON | difficulty | addedDate | quizJSON | currentQuestion | userAnswers | quizState | quizScore |
   |---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### 2. Configure n8n Credentials

In your n8n instance, create three credentials:

| Credential | Type | Notes |
|---|---|---|
| **Telegram API** | Telegram API | Paste the bot token from BotFather |
| **Google Sheets** | Google Sheets OAuth2 | Authorize with Google account that owns the spreadsheet |
| **OpenAI** | OpenAI API | Paste your OpenAI API key |

### 3. Import the Workflow

1. Open your n8n instance.
2. Go to **Workflows → Add Workflow → Import from File**.
3. Select `dr_learner.json`.
4. The workflow will load with 45 nodes.

### 4. Update Credential References

After import, you need to link your credentials to the nodes:

1. **Telegram nodes** (15 nodes) — open any Telegram node, select your Telegram API credential. n8n will prompt to update all similar nodes.
2. **Google Sheets nodes** (7 nodes) — select your Google Sheets credential. Update the **Document ID** to match your spreadsheet.
3. **OpenAI nodes** (2 nodes: `Learn_GetMaterials_Analyze`, `Quiz_GenerateQuestions`) — select your OpenAI credential.
4. **Quiz_SendMaterials** (HTTP Request node) — replace the bot token in the URL with your own token:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/sendMessage
   ```
   > **Note:** The workflow file uses the placeholder `YOUR_BOT_TOKEN_HERE` in this URL. Replace it with your actual bot token after import.

### 5. Activate the Workflow

1. Click **Save** in the workflow editor.
2. Toggle the workflow to **Active**.
3. n8n will register a webhook with Telegram automatically.

## Bot Commands

Open your bot in Telegram and use these commands:

### `/start`
Shows a welcome message with available commands.

### `/learn <url>`
Submit a URL to study.

1. The bot fetches the web page content.
2. OpenAI analyzes it and generates a structured summary.
3. The summary is saved to Google Sheets and sent to you with key points and difficulty rating.

**Example:**
```
/learn https://en.wikipedia.org/wiki/Machine_learning
```

### `/quiz`
Take a quiz on your saved materials.

1. The bot shows a list of your saved materials as inline buttons.
2. Select a material to start a 5-question multiple-choice quiz.
3. Answer each question by tapping A, B, C, or D.
4. After all 5 questions, see your final score.

**Quiz features:**
- **Resume** — if you leave mid-quiz, selecting the same material picks up where you left off.
- **Completed detection** — if you've already finished a quiz, the bot shows your previous score before starting a fresh attempt.
- **Cancel** — tap "❌ Cancel" in the material list to exit.

## Troubleshooting

| Problem | Solution |
|---|---|
| Bot doesn't respond | Check the workflow is **Active** in n8n. Verify the Telegram webhook is registered (check n8n logs). |
| "Bad request" errors | Ensure all credentials are correctly linked. Check that the Google Sheet has the correct column headers. |
| Quiz shows no materials | You need to `/learn` at least one URL before using `/quiz`. |
| Material selection buttons don't appear | Check the bot token in the `Quiz_SendMaterials` HTTP Request node URL. |

## Architecture

```
Telegram Trigger
  ├─ Messages
  │   ├─ /start  → Welcome message
  │   ├─ /learn  → Fetch URL → OpenAI summary → Save to Sheets → Reply
  │   ├─ /quiz   → Load materials → Show selection keyboard
  │   └─ other   → "Unknown command" reply
  └─ Callbacks
      ├─ quiz_cancel → Cancel message
      ├─ quiz_<id>   → Load material → Check quiz state → Generate/Resume → Send question
      └─ ans_<id>_<X> → Process answer → Feedback → Next question or Results
```
