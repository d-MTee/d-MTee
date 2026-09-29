#!/usr/bin/env python3
import base64, json, os, socket, sys
cid=int(os.environ.get('NITRO_ENCLAVE_CID','16'))
port=int(os.environ.get('NITRO_VSOCK_PORT','5000'))
op=sys.argv[1]
payload=sys.argv[2] if len(sys.argv)>2 else ''
nonce=sys.argv[3] if len(sys.argv)>3 else ''
user_data=sys.argv[4] if len(sys.argv)>4 else ''
authorization=sys.argv[5] if len(sys.argv)>5 else ''
s=socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
s.connect((cid,port))
s.sendall((json.dumps({'op':op,'message':payload,'nonce':nonce,'user_data':base64.b64encode(user_data.encode()).decode() if user_data else '', 'authorization':authorization})+'\n').encode())
buf=b''
while not buf.endswith(b'\n'):
    chunk=s.recv(65536)
    if not chunk: break
    buf+=chunk
print(buf.decode().strip())
