"""NeoRead protocol regression fixtures. Never reads real config/credentials."""
import base64
import io
import json
import struct
import sys
import threading
import time
import unittest
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import LocalHttpsBridge as bridge

COLORS = {(230, 30, 30): 'RED', (25, 70, 235): 'BLUE',
          (30, 175, 65): 'GREEN', (245, 210, 20): 'YELLOW'}


def png_answer(encoded):
    png = base64.b64decode(encoded)
    pos, compressed = 8, b''
    width = height = 0
    while pos < len(png):
        n = struct.unpack('>I', png[pos:pos+4])[0]
        kind, data = png[pos+4:pos+8], png[pos+8:pos+8+n]
        if kind == b'IHDR':
            width, height = struct.unpack('>II', data[:8])
        if kind == b'IDAT':
            compressed += data
        pos += 12+n
    if (width, height) != (800, 140):
        raise ValueError('unexpected image geometry')
    pixels = zlib.decompress(compressed)
    row = pixels[70 * (1+width*3):(70+1) * (1+width*3)]
    if row[0] != 0:
        raise ValueError('fixture expects RGB PNG filter 0')
    return ' '.join(COLORS[tuple(row[1+(i*100+50)*3:1+(i*100+50)*3+3])] for i in range(8))


def event(choices, **extra):
    return b'data: ' + json.dumps(dict(choices=choices, **extra), ensure_ascii=False).encode() + b'\n\n'


def choice(content=None, finish=None):
    d = {} if content is None else {'content': content}
    c = {'index': 0, 'delta': d}
    if finish is not None:
        c['finish_reason'] = finish
    return c


def reply(text, tail=True):
    data = event([choice(text)]) + event([choice(finish='stop')])
    if tail:
        data += event([choice()], usage={'total_tokens': 12})
    return data + b'data: [DONE]\n\n'


class VisionBackend(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    seen = []
    def log_message(self, *args):
        pass
    def do_GET(self):
        out = {'data': [{'id': 'valid'}, {'id': 'unsupported'}]}
        raw = json.dumps(out).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        VisionBackend.seen.append(payload)
        model = payload['model']
        status, media = 200, 'text/event-stream'
        if model in ('unsupported', 'auth', 'badmodel'):
            status = 401 if model == 'auth' else 400
            message = 'image input unsupported' if model == 'unsupported' else 'model not found'
            raw, media = json.dumps({'error': message}).encode(), 'application/json'
        else:
            content = payload['messages'][-1]['content']
            image = next(p['image_url']['url'] for p in content if p['type'] == 'image_url')
            text = png_answer(image.split(',', 1)[1])
            if model == 'wrong':
                text = 'RED'  # Accepts the image, but does not actually solve it.
            raw = reply(text)
            if model == 'plain':
                raw, media = json.dumps({'choices': [{'message': {'content': text}}]}).encode(), 'application/json'
            if model == 'truncated':
                raw = raw.replace(b'data: [DONE]\n\n', b'')
        self.send_response(status)
        self.send_header('Content-Type', media)
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class SSECompatibility(unittest.TestCase):
    def parse(self, data):
        return bridge._read_chat_probe(io.BytesIO(data), time.monotonic()+2)

    def test_usage_empty_choice_after_stop_is_canonicalised(self):
        stats = {}
        data = b''.join(bridge._chat_sse_chunks(io.BytesIO(reply('RED BLUE')), stats))
        self.assertIn(b'"choices":[],"usage":{"total_tokens":12}', data)
        self.assertEqual(stats['normalised'], 1)
        self.assertEqual(self.parse(data), 'RED BLUE')

    def test_valid_stream_is_byte_for_byte_unchanged(self):
        data = reply('GREEN YELLOW', tail=False)
        self.assertEqual(b''.join(bridge._chat_sse_chunks(io.BytesIO(data), {})), data)

    def test_real_content_after_stop_remains_an_error(self):
        data = event([choice('RED', 'stop')]) + event([choice('BLUE')]) + b'data: [DONE]\n\n'
        with self.assertRaises(ValueError):
            self.parse(data)

    def test_missing_done_not_fabricated(self):
        with self.assertRaises(ValueError):
            self.parse(event([choice('RED', 'stop')]))

    def test_missing_stop_not_fabricated(self):
        with self.assertRaises(ValueError):
            self.parse(event([choice('RED')]) + b'data: [DONE]\n\n')

    def test_unterminated_done_frame_not_accepted(self):
        with self.assertRaises(ValueError):
            self.parse(event([choice('RED', 'stop')]) + b'data: [DONE]\n')

    def test_length_finish_remains_failure(self):
        with self.assertRaises(ValueError):
            self.parse(event([choice('RED', 'length')]) + b'data: [DONE]\n\n')

    def test_error_frame_is_unchanged(self):
        data = event([], error={'message': 'upstream failed'})
        self.assertEqual(b''.join(bridge._chat_sse_chunks(io.BytesIO(data), {})), data)
        with self.assertRaises(ValueError):
            self.parse(data)

    def test_reasoning_only_is_not_final_text(self):
        data = event([{'index': 0, 'delta': {'reasoning_content': 'RED'}, 'finish_reason': 'stop'}])
        with self.assertRaises(ValueError):
            self.parse(data + b'data: [DONE]\n\n')

    def test_crlf_usage_frames(self):
        self.assertEqual(self.parse(reply('RED BLUE').replace(b'\n', b'\r\n')), 'RED BLUE')

    def test_deadline_is_enforced(self):
        with self.assertRaises(TimeoutError):
            bridge._read_chat_probe(io.BytesIO(reply('RED')), time.monotonic()-1)


class VisionChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), VisionBackend)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = 'http://127.0.0.1:%d/v1' % cls.server.server_port
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_challenge_has_correct_pixels_and_hidden_answer(self):
        with patch.object(bridge.secrets, 'token_bytes', return_value=bytes(range(8))):
            image, expected = bridge._vision_challenge()
        self.assertEqual(expected, 'RED BLUE GREEN YELLOW RED BLUE GREEN YELLOW')
        self.assertEqual(png_answer(image), expected)
        self.assertNotIn(expected, bridge.VISION_PROMPT)

    def test_correct_pixels_and_stream_terminal_pass(self):
        ok, _ = bridge._vision_probe('valid', self.base, timeout=2)
        self.assertIs(ok, True)
        p = VisionBackend.seen[-1]
        self.assertIs(p['stream'], True)
        self.assertTrue(p['stream_options']['include_usage'])
        self.assertNotIn('max_tokens', p)  # No 16-token truncation of reasoning.

    def test_http_200_wrong_colors_does_not_pass(self):
        self.assertIs(bridge._vision_probe('wrong', self.base, timeout=2)[0], False)

    def test_json_even_with_correct_answer_is_not_sse(self):
        self.assertIsNone(bridge._vision_probe('plain', self.base, timeout=2)[0])

    def test_incomplete_stream_not_passed(self):
        self.assertIsNone(bridge._vision_probe('truncated', self.base, timeout=2)[0])

    def test_image_rejection_is_negative(self):
        self.assertIs(bridge._vision_probe('unsupported', self.base, timeout=2)[0], False)

    def test_auth_failure_is_unknown_not_no_vision(self):
        self.assertIsNone(bridge._vision_probe('auth', self.base, timeout=2)[0])

    def test_unknown_model_is_unknown_not_no_vision(self):
        self.assertIsNone(bridge._vision_probe('badmodel', self.base, timeout=2)[0])

    def test_batch_preserves_order_and_cap(self):
        models = ['valid', 'wrong', 'plain', 'unsupported']
        results, note = bridge._test_vision(models, self.base, max_n=3, workers=2, timeout=2)
        self.assertEqual([r['id'] for r in results], models[:3])
        self.assertEqual([r['ok'] for r in results], [True, False, None])
        self.assertIn('3', note)


if __name__ == '__main__':
    unittest.main()
