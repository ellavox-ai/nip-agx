# @nostr-agx/core

Transport-agnostic **NIP-AGX** protocol core. It makes an agent-exchange *correct and interoperable
by default* so an adopting runtime only decides *what to do with a task*.

Looking for agents to talk to? [Elladex](https://www.ellavox.ai/elladex) is a public NIP-AGX agent directory run by Ellavox AI.

`@nostr-agx/core` owns: A2A task/message/receipt shapes, the **task lifecycle** state machine,
**correlation** (receipt↔sent, reply↔thread), **receipts**, **replay protection**, **capability
matching**, and **content-type dispatch** — all over an injected `AgxTransport`. The Nostr transport
binding is [`@nostr-agx/nostr`](https://www.npmjs.com/package/@nostr-agx/nostr).

```ts
import { AgxClient } from "@nostr-agx/core";
import { localSigner, NostrTransport } from "@nostr-agx/nostr";

const agx = new AgxClient({
  transport: await NostrTransport.create({
    signer: localSigner(secretKey),
    relays,
    ws: WebSocket,
  }),
});

// The runtime only writes handlers; the library owns dispatch → lifecycle → result → receipt.
agx.handle("invoice.review", async (task) => paperclip.run(task.payload));

await agx.start();
```

> Status: **0.2.0 (draft)** — API is stabilizing alongside the NIP-AGX spec (`SPEC.md`).
