import unittest, subprocess
from pathlib import Path
class InstallTest(unittest.TestCase):
 def test_installer_syntax_and_no_automatic_start(self):
  script=Path(__file__).resolve().parents[1]/'install.sh'
  self.assertEqual(subprocess.run(['bash','-n',str(script)],capture_output=True).returncode,0)
  text=script.read_text();self.assertNotIn('systemctl --user start',text);self.assertNotIn('systemctl --user enable',text)
  self.assertIn('npm ci',text);self.assertIn('npm run check',text)
