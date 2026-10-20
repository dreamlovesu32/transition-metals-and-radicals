"""Create local secret file once. Never prints the session encryption key."""
import os
from pathlib import Path
from cryptography.fernet import Fernet

ROOT=Path(__file__).resolve().parent

def main():
    folder=ROOT/'.private';folder.mkdir(mode=0o700,exist_ok=True)
    target=folder/'member.env'
    if target.exists():raise SystemExit('Private configuration already exists; no overwrite performed.')
    if os.name=='nt':
        import csv,io,subprocess
        account=subprocess.check_output(['whoami','/user','/fo','csv','/nh'],text=True)
        sid=next(csv.reader(io.StringIO(account)))[1]
        subprocess.run(['icacls',str(folder),'/remove:g','*S-1-3-4','*S-1-5-32-544'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['icacls',str(folder),'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F','*S-1-5-18:(OI)(CI)F'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    template=(ROOT/'.env.example').read_text(encoding='utf-8-sig')
    template=template.replace('READ_MEMBER_SESSION_KEY=','READ_MEMBER_SESSION_KEY='+Fernet.generate_key().decode())
    with target.open('x',encoding='utf-8') as handle:handle.write(template)
    if os.name!='nt':target.chmod(0o600)
    print('Created local .private/member.env; the key was written privately and was not displayed. Fill database/auth configuration locally; never paste credentials into chat.')

if __name__=='__main__':main()
