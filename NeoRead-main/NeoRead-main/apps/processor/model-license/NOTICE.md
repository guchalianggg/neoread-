# PP-DocLayoutV3 FP32 ONNX weights

NeoRead distributes a locally converted FP32 copy of the PP-DocLayoutV3 layout
detection weights under Apache-2.0. The license text is included in `LICENSE`
beside this notice.

- Upstream weights: https://huggingface.co/PaddlePaddle/PP-DocLayoutV3_safetensors
- FP16 ONNX export: https://huggingface.co/stefanj0/PP-DocLayoutV3-FP16-ONNX
  at revision `ca5155572513b7832d297255a1f5cab0ff4b0202`.
- Conversion input (byte-identical FP16 mirror):
  https://huggingface.co/bu44er/PP-DocLayoutV3-FP16-ONNX at revision
  `58dfa00ba1135e027817cbd5802f1f0df62aa5c0`; the revision is kept in the
  bundled filename as the provenance marker.
- Conversion: every FP16 tensor initializer was widened to FP32 and the
  intermediate `Cast` operators were retargeted to FP32. Graph structure, box
  decoding and the omitted mask/polygon head are unchanged; the ONNX Runtime
  CPU execution provider no longer converts FP16 weights on every inference.
- Distribution: https://github.com/guchalianggg/neoread-/releases/tag/model-v1
- File size: 134,138,654 bytes.
- SHA256: `7bba2a4c5dbd13d4727be96759977fb2b06fbc3a1114feb306231c95e8d839e4`.

NeoRead is not affiliated with or endorsed by PaddlePaddle.
