(function (global) {
  'use strict';

  const DFU_SERVICE_UUID = '0000fe59-0000-1000-8000-00805f9b34fb';
  const BUTTONLESS_CHAR_UUID = '8ec90003-f315-4f60-9fb8-838830daea50';
  const DFU_CONTROL_CHAR_UUID = '8ec90001-f315-4f60-9fb8-838830daea50';
  const DFU_PACKET_CHAR_UUID = '8ec90002-f315-4f60-9fb8-838830daea50';
  const RESPONSE_OPCODE = 0x60;
  const RESULT_SUCCESS = 0x01;
  const RESULT_OPERATION_NOT_PERMITTED = 0x08;
  const OBJECT_COMMAND = 0x01;
  const OBJECT_DATA = 0x02;
  const PACKET_SIZE = 20;
  const PRN_INTERVAL = 12;
  const PACKET_BURST_SIZE = 6;
  const PACKET_BURST_PAUSE_MS = 4;
  const DFU_READY_DELAY_MS = 350;
  const TRANSFER_RETRY_LIMIT = 2;
  const COMMAND_TIMEOUT_MS = 12000;

  const OP = Object.freeze({
    CREATE: 0x01,
    SET_PRN: 0x02,
    CRC: 0x03,
    EXECUTE: 0x04,
    SELECT: 0x06,
    ABORT: 0x0C
  });

  const RESULT_NAMES = Object.freeze({
    0x00: '无效响应',
    0x02: '不支持的操作',
    0x03: '参数无效',
    0x04: '存储空间不足',
    0x05: '固件签名或硬件版本校验失败',
    0x07: '对象类型不支持',
    0x08: '当前状态不允许此操作',
    0x0A: '操作失败',
    0x0B: '扩展错误'
  });

  class DfuError extends Error {
    constructor(message, result = null, extended = null) {
      super(message);
      this.name = 'DfuError';
      this.result = result;
      this.extended = extended;
    }
  }

  class ResumeMismatchError extends Error {
    constructor() {
      super('设备中的断点与当前升级包不一致。');
      this.name = 'ResumeMismatchError';
    }
  }

  class DataIntegrityError extends Error {
    constructor(actualOffset, expectedOffset, actualCrc, expectedCrc) {
      super(`设备数据校验不一致：偏移 ${actualOffset}/${expectedOffset}，CRC ${actualCrc.toString(16).padStart(8, '0').toUpperCase()}/${expectedCrc.toString(16).padStart(8, '0').toUpperCase()}。`);
      this.name = 'DataIntegrityError';
      this.actualOffset = actualOffset;
      this.expectedOffset = expectedOffset;
      this.actualCrc = actualCrc;
      this.expectedCrc = expectedCrc;
    }
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function readU32(data, offset) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
  }

  function appendU32(target, offset, value) {
    new DataView(target.buffer).setUint32(offset, value >>> 0, true);
  }

  function crc32(data, initial = 0) {
    let crc = (initial ^ 0xFFFFFFFF) >>> 0;
    for (let index = 0; index < data.length; index++) {
      crc = (crc ^ data[index]) >>> 0;
      for (let bit = 0; bit < 8; bit++) {
        crc = ((crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0)) >>> 0;
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('当前浏览器不支持 OTA ZIP 解压，请升级 Chrome 或 Edge。');
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function findEndOfCentralDirectory(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const start = Math.max(0, data.length - 0xFFFF - 22);
    for (let offset = data.length - 22; offset >= start; offset--) {
      if (view.getUint32(offset, true) === 0x06054B50) return offset;
    }
    throw new Error('不是有效的 OTA ZIP 文件。');
  }

  async function readZipEntries(arrayBuffer) {
    const data = new Uint8Array(arrayBuffer);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const eocd = findEndOfCentralDirectory(data);
    const entryCount = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder('utf-8');
    const entries = new Map();

    for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
      if (offset + 46 > data.length || view.getUint32(offset, true) !== 0x02014B50) {
        throw new Error('OTA ZIP 目录损坏。');
      }

      const method = view.getUint16(offset + 10, true);
      const expectedCrc = view.getUint32(offset + 16, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decoder.decode(data.slice(offset + 46, offset + 46 + nameLength));

      if (!name.endsWith('/')) {
        if (localOffset + 30 > data.length || view.getUint32(localOffset, true) !== 0x04034B50) {
          throw new Error(`OTA ZIP 中的 ${name} 已损坏。`);
        }
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = data.slice(dataStart, dataStart + compressedSize);
        let unpacked;
        if (method === 0) unpacked = compressed;
        else if (method === 8) unpacked = await inflateRaw(compressed);
        else throw new Error(`OTA ZIP 使用了不支持的压缩方式：${method}。`);

        if (unpacked.length !== uncompressedSize || crc32(unpacked) !== expectedCrc) {
          throw new Error(`OTA ZIP 中的 ${name} 校验失败。`);
        }
        entries.set(name, unpacked);
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  function findEntry(entries, requestedName, suffix) {
    if (requestedName && entries.has(requestedName)) return entries.get(requestedName);
    const normalized = requestedName ? requestedName.replace(/\\/g, '/') : '';
    for (const [name, value] of entries) {
      if ((normalized && name.endsWith(`/${normalized}`)) || name.toLowerCase().endsWith(suffix)) return value;
    }
    return null;
  }

  async function parsePackage(file) {
    if (!file || !file.name.toLowerCase().endsWith('.zip')) {
      throw new Error('请选择 EPD-nRF52-ota.zip。');
    }
    const entries = await readZipEntries(await file.arrayBuffer());
    const manifestBytes = findEntry(entries, 'manifest.json', '/manifest.json') || entries.get('manifest.json');
    if (!manifestBytes) throw new Error('升级包缺少 manifest.json。');

    let manifest;
    try {
      manifest = JSON.parse(new TextDecoder('utf-8').decode(manifestBytes));
    } catch (error) {
      throw new Error('升级包的 manifest.json 无法解析。');
    }
    const application = manifest && manifest.manifest && manifest.manifest.application;
    if (!application) throw new Error('升级包不包含 nRF52811 应用固件。');

    const firmware = findEntry(entries, application.bin_file, '.bin');
    const initPacket = findEntry(entries, application.dat_file, '.dat');
    if (!firmware || !initPacket) throw new Error('升级包缺少 BIN 或 DAT 文件。');
    if (firmware.length === 0 || firmware.length > 0x10000) throw new Error('应用固件超出 nRF52811 的 64 KiB 主区。');
    if (initPacket.length === 0 || initPacket.length > 4096) throw new Error('升级包的 DAT 文件大小无效。');

    return Object.freeze({
      name: file.name,
      firmware,
      initPacket,
      firmwareCrc: crc32(firmware)
    });
  }

  async function writeCharacteristic(characteristic, value, withoutResponse) {
    const data = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (withoutResponse && typeof characteristic.writeValueWithoutResponse === 'function') {
      return characteristic.writeValueWithoutResponse(data);
    }
    if (!withoutResponse && typeof characteristic.writeValueWithResponse === 'function') {
      return characteristic.writeValueWithResponse(data);
    }
    return characteristic.writeValue(data);
  }

  async function enterBootloader(device) {
    if (!device || !device.gatt) throw new Error('请先连接墨水屏设备。');
    const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
    const service = await server.getPrimaryService(DFU_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(BUTTONLESS_CHAR_UUID);
    await characteristic.startNotifications();

    let indicationHandler;
    const indication = new Promise((resolve, reject) => {
      indicationHandler = event => {
        const value = event.target.value;
        const response = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (response.length < 3 || response[0] !== 0x20 || response[1] !== 0x01) return;
        characteristic.removeEventListener('characteristicvaluechanged', indicationHandler);
        if (response[2] === RESULT_SUCCESS) resolve();
        else reject(new Error(`设备拒绝进入升级模式，错误码 0x${response[2].toString(16).padStart(2, '0')}。`));
      };
      characteristic.addEventListener('characteristicvaluechanged', indicationHandler);
    });

    const disconnected = device.gatt.connected
      ? new Promise(resolve => device.addEventListener('gattserverdisconnected', resolve, { once: true }))
      : Promise.resolve();
    try {
      await writeCharacteristic(characteristic, new Uint8Array([0x01]), false);
      await withTimeout(indication, 6000, '设备没有确认进入升级模式。');
      await withTimeout(disconnected, 12000, '设备没有切换到 DfuTarg。');
    } finally {
      characteristic.removeEventListener('characteristicvaluechanged', indicationHandler);
    }
  }

  class Client {
    constructor(pkg, callbacks = {}) {
      this.pkg = pkg;
      this.callbacks = callbacks;
      this.device = null;
      this.server = null;
      this.control = null;
      this.packet = null;
      this.pending = null;
      this.prnPending = null;
      this.prnPacketCount = 0;
      this.cancelled = false;
      this.onNotification = this.onNotification.bind(this);
    }

    status(message) {
      if (typeof this.callbacks.status === 'function') this.callbacks.status(message);
    }

    progress(value, message) {
      if (typeof this.callbacks.progress === 'function') this.callbacks.progress(value, message);
    }

    cancel() {
      this.cancelled = true;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(new Error('OTA 已取消。'));
      }
      this.pending = null;
      if (this.prnPending) {
        clearTimeout(this.prnPending.timer);
        this.prnPending.reject(new Error('OTA 已取消。'));
      }
      this.prnPending = null;
      if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
    }

    assertActive() {
      if (this.cancelled) throw new Error('OTA 已取消。');
      if (!this.device || !this.device.gatt.connected) throw new Error('DfuTarg 蓝牙连接已断开。');
    }

    async selectDevice(options = {}) {
      if (!navigator.bluetooth) throw new Error('当前浏览器不支持 Web Bluetooth。');
      if (options.grantedOnly && typeof navigator.bluetooth.getDevices === 'function') {
        const devices = await navigator.bluetooth.getDevices();
        this.device = devices.find(device => device.name && device.name.startsWith('DfuTarg')) || null;
      }
      if (!this.device && options.grantedOnly) {
        const error = new Error('首次网页 OTA 需要点击“选择 DfuTarg 继续升级”并授权升级设备。');
        error.name = 'DfuPermissionRequired';
        throw error;
      }
      if (!this.device) {
        this.device = await navigator.bluetooth.requestDevice({
          filters: [
            { services: [DFU_SERVICE_UUID] },
            { namePrefix: 'DfuTarg' }
          ],
          optionalServices: [DFU_SERVICE_UUID]
        });
      }
      this.status(`正在连接 ${this.device.name || 'DfuTarg'}...`);
      let connectError;
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          this.server = this.device.gatt.connected ? this.device.gatt : await this.device.gatt.connect();
          break;
        } catch (error) {
          connectError = error;
          await delay(500);
        }
      }
      if (!this.server) throw connectError || new Error('无法连接 DfuTarg。');
      const service = await this.server.getPrimaryService(DFU_SERVICE_UUID);
      this.control = await service.getCharacteristic(DFU_CONTROL_CHAR_UUID);
      this.packet = await service.getCharacteristic(DFU_PACKET_CHAR_UUID);
      await this.control.startNotifications();
      this.control.addEventListener('characteristicvaluechanged', this.onNotification);
      await this.command(new Uint8Array([OP.SET_PRN, PRN_INTERVAL, 0x00]));
      this.prnPacketCount = 0;
      await delay(DFU_READY_DELAY_MS);
    }

    onNotification(event) {
      const value = event.target.value;
      const response = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      if (response.length < 3 || response[0] !== RESPONSE_OPCODE) return;
      if ((!this.pending || response[1] !== this.pending.op) && response[1] === OP.CRC && this.prnPending) {
        const pending = this.prnPending;
        this.prnPending = null;
        clearTimeout(pending.timer);
        if (response[2] === RESULT_SUCCESS)
          pending.resolve(response);
        else
          pending.reject(new DfuError('DFU 数据回执失败。', response[2]));
        return;
      }
      if (!this.pending || response[1] !== this.pending.op) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      if (response[2] === RESULT_SUCCESS) {
        pending.resolve(response);
      } else {
        const result = response[2];
        const extended = result === 0x0B && response.length > 3 ? response[3] : null;
        const suffix = extended == null ? '' : `，扩展码 0x${extended.toString(16).padStart(2, '0')}`;
        pending.reject(new DfuError(`${RESULT_NAMES[result] || 'DFU 操作失败'}（0x${result.toString(16).padStart(2, '0')}${suffix}）`, result, extended));
      }
    }

    async command(value) {
      this.assertActive();
      if (this.pending) throw new Error('上一条 DFU 命令尚未完成。');
      const op = value[0];
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending && this.pending.op === op) this.pending = null;
          reject(new Error(`DFU 命令 0x${op.toString(16).padStart(2, '0')} 响应超时。`));
        }, COMMAND_TIMEOUT_MS);
        this.pending = { op, resolve, reject, timer };
      });
      try {
        await writeCharacteristic(this.control, value, false);
      } catch (error) {
        if (this.pending && this.pending.op === op) {
          clearTimeout(this.pending.timer);
          this.pending = null;
        }
        throw error;
      }
      return response;
    }

    async selectObject(type) {
      const response = await this.command(new Uint8Array([OP.SELECT, type]));
      if (response.length < 15) throw new Error('DFU SELECT 响应长度无效。');
      return {
        maxSize: readU32(response, 3),
        offset: readU32(response, 7),
        crc: readU32(response, 11)
      };
    }

    async createObject(type, size) {
      const command = new Uint8Array(6);
      command[0] = OP.CREATE;
      command[1] = type;
      appendU32(command, 2, size);
      await this.command(command);
      this.prnPacketCount = 0;
    }

    waitForPrn() {
      if (this.prnPending) throw new Error('上一条 DFU 数据回执尚未完成。');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.prnPending = null;
          reject(new Error('DFU 数据回执超时。'));
        }, COMMAND_TIMEOUT_MS);
        this.prnPending = { resolve, reject, timer };
      });
    }

    verifyCrcResponse(response, expectedOffset, expectedCrc) {
      const actualOffset = response.length >= 7 ? readU32(response, 3) : 0;
      const actualCrc = response.length >= 11 ? readU32(response, 7) : 0;
      if (response.length < 11 || actualOffset !== expectedOffset || actualCrc !== expectedCrc) {
        throw new DataIntegrityError(actualOffset, expectedOffset, actualCrc, expectedCrc);
      }
    }

    async writePackets(data, start, end, baseProgress, progressSpan) {
      let sent = start;
      while (sent < end) {
        this.assertActive();
        const next = Math.min(sent + PACKET_SIZE, end);
        this.prnPacketCount++;
        const prn = this.prnPacketCount >= PRN_INTERVAL ? this.waitForPrn() : null;
        try {
          await writeCharacteristic(this.packet, data.slice(sent, next), true);
        } catch (error) {
          if (prn && this.prnPending) {
            clearTimeout(this.prnPending.timer);
            this.prnPending = null;
          }
          throw error;
        }
        sent = next;
        if (!prn && this.prnPacketCount > 0 && this.prnPacketCount % PACKET_BURST_SIZE === 0) {
          await delay(PACKET_BURST_PAUSE_MS);
        }
        if (prn) {
          const response = await prn;
          this.prnPacketCount = 0;
          this.verifyCrcResponse(response, sent, crc32(data.slice(0, sent)));
        }
        if ((sent & 0xFF) < PACKET_SIZE || sent === end) {
          const ratio = data.length ? sent / data.length : 1;
          this.progress(baseProgress + ratio * progressSpan, `正在传输固件：${Math.floor(ratio * 100)}%`);
        }
      }
    }

    async reconnectForRetry(attempt) {
      this.status(`启动阶段传输未稳定，正在自动重连重试（${attempt}/${TRANSFER_RETRY_LIMIT}）...`);
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(new Error('DFU 正在重新连接。'));
        this.pending = null;
      }
      if (this.prnPending) {
        clearTimeout(this.prnPending.timer);
        this.prnPending.reject(new Error('DFU 正在重新连接。'));
        this.prnPending = null;
      }
      if (this.control) this.control.removeEventListener('characteristicvaluechanged', this.onNotification);
      if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
      this.server = null;
      this.control = null;
      this.packet = null;
      this.prnPacketCount = 0;
      await delay(900);
      await this.selectDevice({ grantedOnly: true });
    }

    async verifyOffsetAndCrc(expectedOffset, expectedCrc) {
      const response = await this.command(new Uint8Array([OP.CRC]));
      this.verifyCrcResponse(response, expectedOffset, expectedCrc);
    }

    async executeAllowAlreadyDone() {
      try {
        await this.command(new Uint8Array([OP.EXECUTE]));
      } catch (error) {
        if (!(error instanceof DfuError) || error.result !== RESULT_OPERATION_NOT_PERMITTED) throw error;
      }
    }

    async transferCommandObject() {
      const data = this.pkg.initPacket;
      const selected = await this.selectObject(OBJECT_COMMAND);
      if (selected.offset > data.length || crc32(data.slice(0, selected.offset)) !== selected.crc) {
        throw new ResumeMismatchError();
      }
      if (selected.offset === data.length) {
        await this.executeAllowAlreadyDone();
        return;
      }
      if (selected.offset === 0) await this.createObject(OBJECT_COMMAND, data.length);
      await this.writePackets(data, selected.offset, data.length, 0, 5);
      await this.verifyOffsetAndCrc(data.length, crc32(data));
      await this.command(new Uint8Array([OP.EXECUTE]));
    }

    async transferDataObjects() {
      const data = this.pkg.firmware;
      const selected = await this.selectObject(OBJECT_DATA);
      if (!selected.maxSize || selected.offset > data.length || crc32(data.slice(0, selected.offset)) !== selected.crc) {
        throw new ResumeMismatchError();
      }

      let offset = selected.offset;
      let runningCrc = selected.crc;
      if (offset > 0 && offset % selected.maxSize === 0) await this.executeAllowAlreadyDone();

      while (offset < data.length) {
        const objectStart = offset - (offset % selected.maxSize);
        const objectEnd = Math.min(objectStart + selected.maxSize, data.length);
        if (offset === objectStart) await this.createObject(OBJECT_DATA, objectEnd - objectStart);
        await this.writePackets(data, offset, objectEnd, 5, 95);
        runningCrc = crc32(data.slice(offset, objectEnd), runningCrc);
        offset = objectEnd;
        await this.verifyOffsetAndCrc(offset, runningCrc);
        await this.command(new Uint8Array([OP.EXECUTE]));
      }
    }

    async transfer() {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.transferCommandObject();
          await this.transferDataObjects();
          return;
        } catch (error) {
          if (!(error instanceof ResumeMismatchError) || attempt > 0) throw error;
          this.status('断点与升级包不一致，正在重新开始...');
          await this.command(new Uint8Array([OP.ABORT]));
          await delay(100);
        }
      }
    }

    async upload(options = {}) {
      try {
        await this.selectDevice(options);
        this.status('DfuTarg 已连接，正在校验升级包...');
        for (let attempt = 0; ; attempt++) {
          try {
            await this.transfer();
            break;
          } catch (error) {
            if (!(error instanceof DataIntegrityError) || attempt >= TRANSFER_RETRY_LIMIT) throw error;
            try {
              if (this.device && this.device.gatt && this.device.gatt.connected) {
                await this.command(new Uint8Array([OP.ABORT]));
              }
            } catch (abortError) {
              // Reconnecting below also clears the interrupted DFU object state.
            }
            await this.reconnectForRetry(attempt + 1);
          }
        }
        this.progress(100, '升级完成，设备正在重启。');
      } finally {
        if (this.control) this.control.removeEventListener('characteristicvaluechanged', this.onNotification);
        if (this.device && this.device.gatt && this.device.gatt.connected) this.device.gatt.disconnect();
      }
    }
  }

  global.SecureDfu = Object.freeze({
    DFU_SERVICE_UUID,
    Client,
    crc32,
    enterBootloader,
    parsePackage
  });
})(window);
