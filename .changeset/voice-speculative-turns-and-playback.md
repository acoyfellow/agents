---
"agents": minor
---

Voice: `withVoice({ speculativeTurns: true })` starts replies on Flux's eager end of turn and holds them until the turn is confirmed, `VoiceClient` keeps `speaking` until playback drains, adds `interruptMode: "duck"`, and reports `playbacklevelchange`. See [Voice Agents](https://github.com/cloudflare/agents/blob/main/docs/agents/voice.md#speculative-turns).
