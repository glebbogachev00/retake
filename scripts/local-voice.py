"""Retake's local voices: Kokoro and Qwen3 (Aiden), on this Mac.

Speaks the way edge-tts does, so narration does not care which it got:
  --voice kokoro:<voice> | qwen:<speaker>   --rate +N%   --text ...
  --write-media out.mp3   [--write-subtitles out.srt]
Each sentence is its own take (the voice keeps its shape), joined with short
breaths; the SRT says where each falls. Levelled to Edge's loudness so a
comparison hears the voice, not the volume.

  --pronounce "text"   print the text as Kokoro will be given it (no models)

Run by Retake through uv:  uvx --from mlx-audio==0.5.5 --with soundfile
--with "misaki[en]" python local-voice.py ...  Apple Silicon only (MLX).
"""
import argparse, os, re, subprocess, sys, tempfile

# ---------- words Kokoro's guesser gets wrong in demo narration ----------
# "record" is a heteronym: the guesser hears a music RE-cord in "press record".
# In a demo script it is almost always the verb (re-CORD); after a word that
# makes it a noun ("a record", "the record") it is left alone. "demos" came
# out "dee-moss". Overrides use misaki's own [word](/phonemes/) form.
NOUN_BEFORE = {"a", "an", "the", "this", "that", "my", "your", "our", "their", "its", "his", "her",
               "any", "no", "new", "old", "track", "world", "public", "permanent", "every"}
FIXED = {"demos": "dˈɛmOz", "demo": "dˈɛmO"}
VERB = {"record": "ɹəkˈɔɹd", "records": "ɹəkˈɔɹdz"}


def pronounce(text: str) -> str:
    out, prev = [], ""
    for tok in re.split(r"(\W+)", text):
        low = tok.lower()
        if low in VERB and prev not in NOUN_BEFORE:
            tok = f"[{tok}](/{VERB[low]}/)"
        elif low in FIXED:
            tok = f"[{tok}](/{FIXED[low]}/)"
        if tok.strip() and re.match(r"\w", tok):
            prev = low
        out.append(tok)
    return "".join(out)


EDGE_LUFS = -19.8   # measured: Edge's Andrew reading the same lines
SR = 24000
MODELS = {"kokoro": "mlx-community/Kokoro-82M-8bit", "qwen": "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--voice"); p.add_argument("--rate", default="+0%"); p.add_argument("--text")
    p.add_argument("--write-media"); p.add_argument("--write-subtitles"); p.add_argument("--pronounce")
    a = p.parse_args()
    if a.pronounce is not None:
        print(pronounce(a.pronounce))
        return

    import numpy as np, soundfile as sf
    from mlx_audio.tts.utils import load_model

    engine, name = a.voice.split(":", 1)
    speed = 1 + int(re.sub(r"[%+]", "", a.rate) or 0) / 100
    model = load_model(MODELS[engine])

    def say(sentence: str):
        if engine == "kokoro":
            gen = model.generate(text=pronounce(sentence), voice=name, speed=speed, lang_code="a" if name[0] == "a" else "b")
        else:
            gen = model.generate(text=sentence, voice=name, speed=speed, lang_code="english", verbose=False)
        return np.concatenate([np.array(r.audio, dtype=np.float32).reshape(-1) for r in gen])

    paras = [x.strip() for x in re.split(r"\n\s*\n|\n", a.text) if x.strip()] or [a.text]
    audio, cues, t = [], [], 0.0
    for para in paras:
        for sentence in [s for s in re.split(r"(?<=[.!?])\s+", para) if s.strip()]:
            chunk = say(sentence)
            audio.append(chunk); cues.append((t, t + len(chunk) / SR, sentence)); t += len(chunk) / SR
            audio.append(np.zeros(int(SR * 0.3), dtype=np.float32)); t += 0.3
        audio.append(np.zeros(int(SR * 0.35), dtype=np.float32)); t += 0.35

    ff = os.environ.get("FFMPEG_BIN", "ffmpeg")
    wav = tempfile.mktemp(suffix=".wav")
    sf.write(wav, np.concatenate(audio), SR)
    try:
        meas = subprocess.run([ff, "-hide_banner", "-nostats", "-i", wav, "-af", "ebur128=framelog=quiet", "-f", "null", "-"], capture_output=True, text=True).stderr
        found = re.findall(r"I:\s+(-?[\d.]+) LUFS", meas)
        gain = EDGE_LUFS - float(found[-1]) if found else 0.0
        subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-af", f"volume={gain:.2f}dB,alimiter=limit=0.97",
                        "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", a.write_media], check=True)
    finally:
        os.remove(wav)
    if a.write_subtitles:
        ts = lambda s: f"{int(s // 3600):02d}:{int(s % 3600 // 60):02d}:{int(s % 60):02d},{int(round((s % 1) * 1000)) % 1000:03d}"
        with open(a.write_subtitles, "w") as f:
            for i, (st, en, tx) in enumerate(cues, 1):
                f.write(f"{i}\n{ts(st)} --> {ts(en)}\n{tx}\n\n")


if __name__ == "__main__":
    sys.exit(main())
