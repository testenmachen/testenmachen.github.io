// OTA functionality extracted from main frontend
const eFrameType = Object.freeze({
  checkFirmwareVersion: 0,
  checkFirmwareVersionAck: 1,
  init: 2,
  chunk: 3,
  reflashRequest: 4,
  ackOk: 5,
  ackErr: 6,
  ackErrFwSizeToBig: 7,
  ackErrBadHwVersion: 8,
  ackErrTimeoutInternalOp: 9,
  ackErrFwNotComplete: 10,
  none: 255
});

const defaultFixedId = 0x01a1;

class CRC64 {
  static _table = CRC64._makeTable();
  static _makeTable() {
    const POLY = BigInt('0x42F0E1EBA9EA3693');
    const t = [];
    for (let i = 0; i < 256; i++) {
      let crc = BigInt(i) << BigInt(56);
      for (let j = 0; j < 8; j++) {
        crc = (crc & (BigInt(1) << BigInt(63))) ? ((crc << BigInt(1)) ^ POLY) : (crc << BigInt(1));
      }
      t.push(crc & ((BigInt(1) << BigInt(64)) - BigInt(1)));
    }
    return t;
  }
  static compute(buf) {
    let crc = BigInt(0);
    for (const b of new Uint8Array(buf)) {
      const idx = Number((crc >> BigInt(56)) ^ BigInt(b)) & 0xFF;
      crc = CRC64._table[idx] ^ (crc << BigInt(8));
    }
    return crc & ((BigInt(1) << BigInt(64)) - BigInt(1));
  }
}

class COtaProtocol {
  /**
   * @param {object} transport - must implement publish(topic, payload) and subscribe(topic, handler)
   * @param {object} [options]
   * @param {number} [options.hwVersion=1]
   * @param {(msg:string)=>void} [options.onLog]
   */
  constructor(transport, options = {}) {
    this.transport = transport;
    this.hwVersion = options.hwVersion || 1;
    this.onLog = options.onLog || (() => { });
    this.statusCb = options.statusCb || (() => { });
    this._devices = {}; // per-device state
    this.upadateLen = 0;
    // subscribe to incoming OTA down frames

    this.connected = false;

    this.upTopic = 'lw/+/ota/up' // xD we are receiving on up topic, frames to the terminals should be send to /down topic
  }

  onConnect() {
    try {
      this.transport.subscribe(this.upTopic, (topic, payload) => this._onFrame(topic, payload));
      this.connected = true;
      console.log("connected");
    }
    catch (err) {
      console.log("connect err: " + err);
      this.connected = false;
    }
  }

  onDisconnect() {
    console.log("received disconnect state");
    this.connected = false;
  }

  /**
   * Start OTA update for given device IDs
   * @param {string[]} deviceIds
   * @param {ArrayBuffer} firmwareBin
   * @param {number} firmwareVersion
   */
  start(deviceIds, firmwareBin, firmwareVersion) {
    console.log("COtaProt started");

    this.upadateLen = firmwareBin.byteLength;
    console.log("COtaProt fw size: " + this.upadateLen+ "B starting crc calc...");
    const crc64 = BigInt(1234);//CRC64.compute(firmwareBin);
    console.log("COtaProt crc computed");
    deviceIds.forEach(id => {
      // initialize per-device state
      this._devices[id] = {
        buf: firmwareBin,
        version: firmwareVersion,
        crc: crc64,
        offset: 0,
        chunkSize: 4096,
        state: 'init',
      };

      this.statusCb(id, "init", 0);

      this._sendInit(id);
    });
  }

  _topicDown(deviceId) {
    return `lw/${deviceId}/ota/down`;
  }

  _sendInit(deviceId) {
    console.log("sending init frame for dev: " + deviceId);
    const st = this._devices[deviceId];
    const headerLen = 2 + 1;
    const subframeLen = 4 + 4 + 4 + 8;
    const buffer = new ArrayBuffer(headerLen + subframeLen);
    const dv = new DataView(buffer);
    dv.setUint16(0, 0x01A1, true);
    dv.setUint8(2, eFrameType.init);
    let off = headerLen;
    dv.setUint32(off, st.version, true); off += 4;
    dv.setUint32(off, this.hwVersion, true); off += 4;
    dv.setUint32(off, st.buf.byteLength, true); off += 4;
    dv.setBigUint64(off, st.crc, true);
    this.transport.publish(this._topicDown(deviceId), buffer);
    this.onLog(`INIT → ${deviceId}`);
  }

  _sendChunk(deviceId) {
    const st = this._devices[deviceId];
    const remain = st.buf.byteLength - st.offset;
    if (remain <= 0) {
      this._sendReflash(deviceId);
      return;
    }
    const len = Math.min(st.chunkSize, remain);
    const headerLen = 2 + 1;
    const subHeader = 4 + 2;
    const buffer = new ArrayBuffer(headerLen + subHeader + len);
    const dv = new DataView(buffer);
    dv.setUint16(0, 0x01A1, true);
    dv.setUint8(2, eFrameType.chunk);
    let off = headerLen;
    dv.setUint32(off, st.offset, true); off += 4;
    dv.setUint16(off, len, true); off += 2;
    new Uint8Array(buffer, off).set(new Uint8Array(st.buf, st.offset, len));
    const offset = st.offset;
    st.offset += len;
    this.transport.publish(this._topicDown(deviceId), buffer);
    this.onLog(`CHUNK @${offset} (${len} B) → ${deviceId}`);
  }

  _sendReflash(deviceId) {
    const buffer = new ArrayBuffer(2 + 1);
    const dv = new DataView(buffer);
    dv.setUint16(0, 0x01A1, true);
    dv.setUint8(2, eFrameType.reflashRequest);
    this.transport.publish(this._topicDown(deviceId), buffer);
    this.onLog(`REFLASH → ${deviceId}`);
    delete this._devices[deviceId];
  }

  _onFrame(topic, payload) {
    // topic: lw/{deviceId}/ota/down
    // const hex = Array.from(payload)
    //   .map(b => b.toString(16).padStart(2, '0'))
    //   .join(' ');

    // console.log("rx: " + topic + ` → ${hex}`);

    const parts = topic.split('/');
    const id = parts[1];
    console.log('[DBG] parts=', parts, 'id=', id, 'hasState=', !!this._devices[id]);
    const st = this._devices[id];
    if (!st) return; // not in update
    const dv = new DataView(payload.buffer, payload.byteOffset,
      payload.byteLength);

    const fixedId = dv.getUint16(0, true);
    if (fixedId != defaultFixedId) {
      console.log("err frame has wrong fixed id: " + fixedId);
      delete this._devices[id];
      return;
    }
    else {
      console.log("frame id ok");
    }

    const type = dv.getUint8(2);

    console.log("rx ack: " + type);
    switch (type) {
      case eFrameType.ackOk:
        // move offset & send next
        if (st.state === 'init') {
          st.state = 'chunk';
          this.statusCb(id, "init ok", this._getOtaPercentage(id));
        }
        else {
          this.statusCb(id, "sending chunks", this._getOtaPercentage(id));
        }

        this._sendChunk(id);
        break;
      // handle other ACKs as needed
      default:
        this.onLog(`ERR ⨉ ${id}`);
        this.statusCb(id, "ack err: " + type, this._getOtaPercentage(id));
        delete this._devices[id];
        break;
    }
  }

  _getOtaPercentage(deviceId) {
    console.log("_getOtaPercentage id: " + deviceId);
    const state = this._devices[deviceId];
    console.log("_getOtaPercentage s: " + state);
    if (!state) {
      return 0;
    }

    const percentage = 100.0 * state.offset / this.upadateLen;
    console.log("_getOtaPercentage p: " + percentage);
    return percentage;
  }
}

// Funkcje do pokazania/ukrycia panelu OTA
function showOtaPanel() {
  const p = document.getElementById('ota-panel'); p.style.display = 'block';
  const lst = document.getElementById('ota-device-list'); lst.innerHTML = '';
  Object.keys(window.mqttApp.terminals).forEach(id => {
    const lbl = document.createElement('label'); lbl.style.display = 'block';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = id;
    lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' ' + id));
    lst.appendChild(lbl);
  });
}
function hideOtaPanel() { document.getElementById('ota-panel').style.display = 'none'; }

// Obsługa przycisku Start OTA
document.getElementById('ota-start-btn').addEventListener('click', async () => {
  const devs = Array.from(document.querySelectorAll('#ota-device-list input:checked')).map(i => i.value);
  const file = document.getElementById('ota-file').files[0];
  if (!file) { alert('Wybierz .bin'); return; }
  const buf = await file.arrayBuffer();
  const ver = +document.getElementById('ota-fw-version').value;
  window.otaProt.start(devs, buf, ver);
});
