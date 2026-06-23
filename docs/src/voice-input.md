# Voice input

Dictate into the composer instead of typing. Ekorbia records from your
microphone and transcribes your speech **on your machine** — the audio is
never uploaded.

> Voice input is macOS-only for now.

## Dictating

1. Click the **microphone button** in the composer (between the prompt button
   and the model picker).
2. Speak. The button turns red and shows a timer while it's recording.
3. It stops on its own a moment after you finish speaking — or click again to
   stop immediately. Your words are transcribed and inserted at the cursor,
   ready to edit or send. (Prefer to always click to stop? Turn off "Stop
   automatically when I pause" in **Settings → Voice**.)

Press **Esc** while recording to cancel without transcribing.

Voice input is also available in the **quick-query overlay** — the same mic
button sits in the overlay's input row, so you can dictate a quick question
without switching to the main window. The overlay stays open while you're
recording.

By default Ekorbia **sends** the message as soon as a dictation finishes —
speak and it goes, with no Enter or Send click (especially handy in the
overlay: speak a question, get an answer). Turn off "Send automatically after
dictation" in **Settings → Voice** if you'd rather review before sending;
pressing Esc while recording always cancels without sending.

The first time you record, macOS asks for permission to use the microphone —
click **Allow**. If you dismiss it or change your mind later, enable Ekorbia
under **System Settings → Privacy & Security → Microphone**.

## Choosing a speech model

The first time you use voice input, Ekorbia offers to download a small speech
model. Three English models are available:

| Model | Size | Best for |
|-------|------|----------|
| **base.en** | ~142 MB | The recommended default — fast and accurate |
| tiny.en | ~75 MB | The fastest option / lowest memory |
| small.en | ~466 MB | The most accurate, a little slower |

For languages other than English, download a **multilingual** model instead —
`base`, `small`, or `large-v3-turbo` (most accurate, ~1.6 GB). These cover 99
languages and can also translate to English.

Models download once and then run entirely offline. On Apple Silicon
transcription is GPU-accelerated and typically takes well under a second for a
short dictation.

Manage your speech models any time under **Settings → Voice** — download
another, switch which one is the default, or remove ones you don't use.

## Other languages

By default Ekorbia transcribes English. To dictate in another language,
download a **multilingual** model (see above), then open **Settings → Voice**:

- **Language** — choose **Auto-detect** or a specific language. Auto-detect
  works well for a sentence or more of clear speech.
- **Translate to English** — when on, your speech is transcribed *and*
  translated into English in one step.

Both settings apply only to multilingual models; the English-only (`*.en`)
models always produce English.

## Notes

- Everything runs locally. The only network use is the one-time model
  download from Hugging Face; after that, voice input works with the network
  off.
- Dictation works in private chats too — it's just another way to enter text.
- Speech models are separate from your chat (Ollama) models: the model picker
  in the composer chooses which LLM answers; the voice model only turns your
  speech into text.
- If you see "No audio captured," the microphone permission likely isn't
  granted yet — check **System Settings → Privacy & Security → Microphone**.
