import unittest, subprocess, json, os, tempfile, socket, threading
from pathlib import Path
CLI=Path(__file__).resolve().parents[1]/'bin/omarchy-ma-player'
class CliTest(unittest.TestCase):
 def test_stopped_status(self):
  with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as home:
   p=subprocess.run(['python3',str(CLI),'status'],env={**os.environ,'HOME':home},capture_output=True,text=True)
   self.assertEqual(p.returncode,0);self.assertEqual(json.loads(p.stdout)['phase'],'stopped')
 def test_request_roundtrip(self):
  with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as home:
   state=Path(home)/'.local/state/music-assistant-player';state.mkdir(parents=True,mode=0o700)
   with socket.socket(socket.AF_UNIX) as server:
    server.bind(os.path.relpath(state/'player.sock'));os.chmod(state/'player.sock',0o600);server.listen()
    def serve():
     conn,_=server.accept()
     with conn:
      msg=json.loads(conn.makefile('rb').readline());conn.sendall(json.dumps({'result':msg}).encode()+b'\n')
    t=threading.Thread(target=serve);t.start()
    p=subprocess.run(['python3',str(CLI),'request'],input='{"command":"players/get","args":{}}\n',env={**os.environ,'HOME':'.'},cwd=home,capture_output=True,text=True);t.join(2)
    self.assertEqual(p.returncode,0,p.stdout);self.assertEqual(json.loads(p.stdout)['result']['command'],'players/get')
 def test_bad_input(self):
  p=subprocess.run(['python3',str(CLI),'request'],input='not JSON\n',capture_output=True,text=True)
  self.assertNotEqual(p.returncode,0);self.assertEqual(json.loads(p.stdout),{'error':'BAD_REQUEST'})
