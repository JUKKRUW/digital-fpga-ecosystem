"""
backend.py - one way to reach the chat model, whichever program runs it (stdlib only).

  * "llama"  - the llama-server the app manages (Settings ▸ โมเดล AI), the default;
  * "ollama" - an Ollama the user installed: its OpenAI-compatible /v1/chat/completions, models from /api/tags;
  * "openai" - any other OpenAI-compatible server (LM Studio, vLLM, …) at a URL from the settings.

Every caller (the assistant chat, later the memory extractor) goes through `Backend.stream` /
`Backend.complete`. Thinking comes back apart from the answer whichever way the server sends it:
`delta.reasoning_content` (llama-server), `delta.reasoning` (Ollama) or `<think>…</think>` inside the text.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

KINDS = ("llama", "ollama", "openai")
OLLAMA_BASE = "http://127.0.0.1:11434"


class BackendError(RuntimeError):
    pass


class _ThinkSplitter:
    """Splits streamed text into thinking and answer at <think> / </think>, also when a tag is cut
    between two chunks."""
    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self):
        self.inside = False
        self.buf = ""

    def feed(self, s: str):
        self.buf += s
        out = []
        while self.buf:
            tag = self.CLOSE if self.inside else self.OPEN
            i = self.buf.find(tag)
            if i >= 0:
                if i:
                    out.append(("think" if self.inside else "text", self.buf[:i]))
                self.buf = self.buf[i + len(tag):]
                self.inside = not self.inside
                continue
            # keep a tail that may be the start of a tag
            keep = next((k for k in range(min(len(tag) - 1, len(self.buf)), 0, -1) if tag.startswith(self.buf[-k:])), 0)
            emit = self.buf[:len(self.buf) - keep]
            if emit:
                out.append(("think" if self.inside else "text", emit))
            self.buf = self.buf[len(self.buf) - keep:]
            break
        return out

    def flush(self):
        rest, self.buf = self.buf, ""
        return [("think" if self.inside else "text", rest)] if rest else []


class Backend:
    def __init__(self, kind: str = "llama", endpoint: str = "", model: str = ""):
        self.kind = kind if kind in KINDS else "llama"
        if self.kind == "ollama" and not endpoint:
            endpoint = OLLAMA_BASE + "/v1/chat/completions"
        self.endpoint = endpoint or "http://127.0.0.1:8080/v1/chat/completions"
        self.model = model

    def body(self, messages, think=False, temperature=None, max_tokens=2048, response_format=None, stream=True) -> dict:
        b = {"messages": messages, "stream": stream, "max_tokens": int(max_tokens)}
        # Qwen3.5 / Typhoon's own advice: 0.6 when thinking, 0.7 when not
        b["temperature"] = temperature if temperature is not None else (0.6 if think else 0.7)
        if self.model:
            b["model"] = self.model
        if self.kind == "llama":
            b["chat_template_kwargs"] = {"enable_thinking": bool(think)}
        if response_format:
            b["response_format"] = response_format
        return b

    def stream(self, messages, timeout: float = 600, **kw):
        """Yields {"type": "think"|"text", "text"} pieces, then one {"type": "done", "finish", "usage", "timings"}."""
        data = json.dumps(self.body(messages, stream=True, **kw)).encode("utf-8")
        req = urllib.request.Request(self.endpoint, data=data, method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "text/event-stream"})
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            raise BackendError(f"model server: HTTP {e.code} {e.read()[:300].decode('utf-8', 'replace')}")
        except Exception as e:
            raise BackendError(f"the model is not reachable at {self.endpoint}: {e}")
        split = _ThinkSplitter()
        done = {"type": "done", "finish": "", "usage": None, "timings": None}
        if "event-stream" not in (resp.headers.get("Content-Type") or ""):
            # a server that ignores "stream" answers with the whole completion at once
            with resp:
                ev = json.loads(resp.read().decode("utf-8") or "{}")
            if ev.get("error"):
                raise BackendError("model server: " + json.dumps(ev["error"], ensure_ascii=False)[:300])
            ch = (ev.get("choices") or [{}])[0]
            m = ch.get("message") or {}
            th = m.get("reasoning_content") or m.get("reasoning")
            if th:
                yield {"type": "think", "text": th}
            for kind, txt in split.feed(m.get("content") or "") + split.flush():
                yield {"type": kind, "text": txt}
            yield dict(done, finish=ch.get("finish_reason") or "", usage=ev.get("usage"), timings=ev.get("timings"))
            return
        with resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    ev = json.loads(payload)
                except ValueError:
                    continue
                if ev.get("error"):
                    raise BackendError("model server: " + json.dumps(ev["error"], ensure_ascii=False)[:300])
                done["usage"] = ev.get("usage") or done["usage"]
                done["timings"] = ev.get("timings") or done["timings"]
                for ch in ev.get("choices") or []:
                    d = ch.get("delta") or {}
                    th = d.get("reasoning_content") or d.get("reasoning")
                    if th:
                        yield {"type": "think", "text": th}
                    for kind, txt in split.feed(d.get("content") or ""):
                        yield {"type": kind, "text": txt}
                    if ch.get("finish_reason"):
                        done["finish"] = ch["finish_reason"]
        for kind, txt in split.flush():
            yield {"type": kind, "text": txt}
        yield done

    def probe(self, timeout: float = 1.5) -> dict:
        """{"state": "ready" | "down", "model": the name the server reports} from GET …/v1/models."""
        url = self.endpoint.split("/v1/", 1)[0] + "/v1/models"
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                d = json.loads(r.read().decode("utf-8"))
            rows = d.get("data") or d.get("models") or []
            name = (rows[0].get("id") or rows[0].get("name") or "") if rows else ""
            return {"state": "ready", "model": self.model or name.replace("\\", "/").rsplit("/", 1)[-1]}
        except urllib.error.HTTPError as e:
            return {"state": "loading" if e.code == 503 else "down", "model": self.model}
        except Exception:
            return {"state": "down", "model": self.model}

    def complete(self, messages, **kw) -> dict:
        """The whole answer at once: {"text", "think", "finish", "usage", "timings"}."""
        out = {"text": "", "think": ""}
        for ev in self.stream(messages, **kw):
            if ev["type"] == "done":
                out.update({k: v for k, v in ev.items() if k != "type"})
            else:
                out[ev["type"]] += ev["text"]
        out["text"] = out["text"].strip()
        return out


def ollama_models(base: str = OLLAMA_BASE, timeout: float = 2) -> list:
    """Models an installed Ollama has pulled ([] when it is not running)."""
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/api/tags", timeout=timeout) as r:
            return [m.get("name") for m in json.loads(r.read().decode("utf-8")).get("models") or [] if m.get("name")]
    except Exception:
        return []


def from_features(f: dict) -> Backend:
    """The backend the settings pick: features.assistant_backend (llama | ollama | openai), with
    assistant_endpoint / assistant_model; the app's llama-server endpoint by default."""
    kind = f.get("assistant_backend") or "llama"
    if kind == "llama":
        return Backend("llama", f.get("llm_endpoint") or "")
    return Backend(kind, f.get("assistant_endpoint") or "", f.get("assistant_model") or "")
