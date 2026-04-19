import json, serial, struct, time, sys
PORT='/dev/ttyUSB0'
BAUD=9600
SLAVE=1
def crc(data):
    c=0xFFFF
    for b in data:
        c ^= b
        for _ in range(8):
            c = (c >> 1) ^ 0xA001 if (c & 1) else (c >> 1)
    return c
def read_regs(ser,start,count):
    pdu=struct.pack('>BBHH',SLAVE,3,start,count)
    frame=pdu+struct.pack('<H',crc(pdu))
    ser.reset_input_buffer(); ser.write(frame); ser.flush()
    expected=3+count*2+2
    buf=bytearray(); t0=time.time()
    while time.time()-t0 < 2 and len(buf) < expected:
        chunk=ser.read(expected-len(buf))
        if chunk: buf.extend(chunk)
        elif buf: break
    if len(buf) < 5: return None, f'short:{len(buf)}'
    if buf[1] == 0x83: return None, f'exc:{buf[2]:02x}'
    if buf[1] != 3: return None, f'fc:{buf[1]:02x}'
    bc=buf[2]; data=buf[3:3+bc]
    out={}
    for i in range(0,len(data),2):
        if i+1 < len(data): out[start+i//2]=struct.unpack('>H',data[i:i+2])[0]
    return out, 'ok'
def write_fc06(ser,addr,val):
    pdu=struct.pack('>BBHH',SLAVE,0x06,addr,val)
    frame=pdu+struct.pack('<H',crc(pdu))
    ser.reset_input_buffer(); ser.write(frame); ser.flush()
    buf=bytearray(); t0=time.time()
    while time.time()-t0 < 2 and len(buf) < 8:
        chunk=ser.read(8-len(buf))
        if chunk: buf.extend(chunk)
        elif buf: break
    if len(buf) < 4: return f'timeout:{len(buf)}'
    if buf[1] == 0x86: return f'exc:{buf[2]:02x}'
    if len(buf) < 8: return f'short:{len(buf)}'
    return 'ok' if buf[1] == 0x06 else f'fc:{buf[1]:02x}'
def write_fc10(ser,addr,val):
    pdu=struct.pack('>BBHHB',SLAVE,0x10,addr,1,2)+struct.pack('>H',val)
    frame=pdu+struct.pack('<H',crc(pdu))
    ser.reset_input_buffer(); ser.write(frame); ser.flush()
    buf=bytearray(); t0=time.time()
    while time.time()-t0 < 2 and len(buf) < 8:
        chunk=ser.read(8-len(buf))
        if chunk: buf.extend(chunk)
        elif buf: break
    if len(buf) < 4: return f'timeout:{len(buf)}'
    if buf[1] == 0x90: return f'exc:{buf[2]:02x}'
    if len(buf) < 8: return f'short:{len(buf)}'
    return 'ok' if buf[1] == 0x10 else f'fc:{buf[1]:02x}'
CANDIDATES=[int(x) for x in sys.argv[1:]]
probe={}
with serial.Serial(PORT,BAUD,timeout=1.0) as ser:
    for addr in CANDIDATES:
        regs,msg=read_regs(ser,addr,1)
        if not regs or addr not in regs:
            probe[addr]={'read':msg}
            continue
        val=regs[addr]
        fc06=write_fc06(ser,addr,val)
        time.sleep(0.05)
        fc10=write_fc10(ser,addr,val)
        time.sleep(0.05)
        regs2,msg2=read_regs(ser,addr,1)
        probe[addr]={'value':val,'fc06':fc06,'fc10':fc10,'readback': regs2.get(addr) if regs2 else msg2}
print(json.dumps(probe, indent=2))
