
import { BleManager, Device, Subscription } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import { Buffer } from 'buffer';
import EventEmitter from 'events';

export interface JKBMSDevice {
    id: string;
    name: string;
    rssi: number;
    deviceObject?: Device;
}

// Local log storage
const localLogs: string[] = [];
const MAX_LOCAL_LOGS = 200;

function addLocalLog(msg: string) {
    const timestamp = new Date().toLocaleTimeString();
    localLogs.push(`[${timestamp}] ${msg}`);
    if (localLogs.length > MAX_LOCAL_LOGS) {
        localLogs.shift();
    }
}

class BleService extends EventEmitter {
    private static instance: BleService;
    private manager: BleManager;
    private scanning = false;
    private buffer: Buffer = Buffer.alloc(0);
    private subscription: Subscription | null = null;
    private protocolOffset: number = 0;
    private isAuthorized: boolean = false;
    private setupPasscode: string = '';
    public connectedDeviceId: string | null = null;

    public static readonly SERVICE_UUID = 'FFE0';
    public static readonly NOTIFY_UUID = 'FFE1';
    public static readonly WRITE_UUID = 'FFE1';

    public static readonly CHARGE_MOS_OFFSET = 166;
    public static readonly DISCHARGE_MOS_OFFSET = 167;

    private constructor() {
        super();
        this.manager = new BleManager();
    }

    public static getInstance(): BleService {
        if (!BleService.instance) {
            BleService.instance = new BleService();
        }
        return BleService.instance;
    }

    public static getLocalLogs(): string[] {
        return [...localLogs];
    }

    public static clearLocalLogs(): void {
        localLogs.length = 0;
    }

    private log(msg: string) {
        console.log(msg);
        addLocalLog(msg);
    }

    public setProtocolOffset(offset: number) {
        this.protocolOffset = offset;
        this.log(`Protocol offset set to: ${offset}`);
    }

    public setSetupPasscode(code: string) {
        this.setupPasscode = code;
    }

    public getProtocolOffset(): number {
        return this.protocolOffset;
    }

    public async isDeviceConnected(deviceId: string): Promise<boolean> {
        try {
            return await this.manager.isDeviceConnected(deviceId);
        } catch (e) {
            return false;
        }
    }

    // V15: Expose Stop Scan
    public stopScan() {
        this.manager.stopDeviceScan();
        this.scanning = false;
        this.emit('scanStop');
    }

    // V15: Get Connected Devices
    public async getConnectedDevices(): Promise<JKBMSDevice[]> {
        try {
            // Need to provide Service UUID to find connected devices on iOS/Android
            const devices = await this.manager.connectedDevices([BleService.SERVICE_UUID]);
            return devices.map(d => ({
                id: d.id,
                name: d.name || d.localName || 'JK-BMS (Connected)',
                rssi: 0, // Connected devices don't update RSSI easily
                deviceObject: d
            }));
        } catch (e) {
            this.log(`Get Connected Error: ${e}`);
            return [];
        }
    }

    public async requestPermissions(): Promise<boolean> {
        if (Platform.OS === 'android') {
            if (Platform.Version >= 31) {
                const result = await PermissionsAndroid.requestMultiple([
                    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
                    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
                    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
                ]);
                return (
                    result['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED &&
                    result['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED &&
                    result['android.permission.ACCESS_FINE_LOCATION'] === PermissionsAndroid.RESULTS.GRANTED
                );
            } else if (Platform.Version >= 23) {
                const granted = await PermissionsAndroid.request(
                    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
                );
                return granted === PermissionsAndroid.RESULTS.GRANTED;
            }
        }
        return true;
    }

    public async startScan(duration: number = 5): Promise<JKBMSDevice[]> {
        const hasPerms = await this.requestPermissions();
        if (!hasPerms) {
            this.log('Permissions denied');
            return [];
        }

        const state = await this.manager.state();
        if (state !== 'PoweredOn') {
            this.log(`Scan failed: Bluetooth State is ${state}`);
            return [];
        }

        this.scanning = true;
        const foundDevices = new Map<string, JKBMSDevice>();

        return new Promise((resolve) => {
            this.log('Starting Scan...');
            this.manager.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
                if (error) {
                    this.scanning = false;
                    this.emit('scanStop');
                    this.log(`Scan Error: ${error.message}`);
                    return;
                }

                if (device && (device.name || device.localName)) {
                    const name = device.name || device.localName || 'Unknown';
                    // Filter mainly for JK devices but lenient for now
                    if (device.id.startsWith('C8:47:8C') || name.toUpperCase().startsWith('JK')) {
                        if (!foundDevices.has(device.id)) {
                            this.log(`Found: ${name} (${device.id})`);
                            const mapped = {
                                id: device.id,
                                name: name,
                                rssi: device.rssi || 0,
                                deviceObject: device
                            };
                            foundDevices.set(device.id, mapped);
                            this.emit('deviceFound', mapped);
                        }
                    }
                }
            });

            setTimeout(() => {
                // STOP SCAN ONLY IF STILL SCANNING
                if (this.scanning) {
                    this.manager.stopDeviceScan();
                    this.scanning = false;
                    this.log(`Scan Complete. Found ${foundDevices.size} devices.`);
                    this.emit('scanStop');
                }
                resolve(Array.from(foundDevices.values()));
            }, duration * 1000);
        });
    }

    public async connect(deviceId: string): Promise<void> {
        this.buffer = Buffer.alloc(0);
        this.isAuthorized = false;
        this.protocolOffset = 0;
        this.connectedDeviceId = deviceId;

        try {
            this.log(`Connecting to ${deviceId}...`);
            const device = await this.manager.connectToDevice(deviceId);

            this.log('Discovering services...');
            await device.discoverAllServicesAndCharacteristics();

            this.log('Monitoring characteristic...');
            this.subscription = device.monitorCharacteristicForService(
                BleService.SERVICE_UUID,
                BleService.NOTIFY_UUID,
                (error, characteristic) => {
                    if (error) {
                        if (error.message?.includes('disconnected') || error.message?.includes('canceled')) {
                            this.log(`Device disconnected`);
                        } else {
                            this.log(`Notification Error: ${error.message}`);
                        }
                        return;
                    }
                    if (characteristic?.value) {
                        const rawData = Buffer.from(characteristic.value, 'base64');
                        this.buffer = Buffer.concat([this.buffer, rawData]);
                        this.processBuffer();
                    }
                }
            );
            this.log('Notification started');
        } catch (error: any) {
            if (error?.message?.includes('already connected')) {
                this.log('Already connected, resuming...');
                // Consider it connected
                return;
            }
            this.log(`Connection Error: ${error?.message || error}`);
            throw error;
        }
    }

    private processBuffer() {
        const headerSequence = Buffer.from([0x55, 0xAA, 0xEB, 0x90]);
        let headerIndex = this.buffer.indexOf(headerSequence);

        while (headerIndex !== -1) {
            if (headerIndex > 0) {
                this.buffer = Buffer.from(this.buffer.slice(headerIndex));
                headerIndex = 0;
            }

            if (this.buffer.length < 300) {
                break;
            }

            const frameType = this.buffer[4];
            const frame = Buffer.from(this.buffer.slice(0, 300));

            this.emit('data', { type: frameType, data: frame });

            this.buffer = Buffer.from(this.buffer.slice(300));
            headerIndex = this.buffer.indexOf(headerSequence);
        }
    }

    public async disconnect(deviceId: string): Promise<void> {
        this.log(`Safely disconnecting from ${deviceId}...`);

        if (this.subscription) {
            try {
                this.subscription.remove();
            } catch (e) { }
            this.subscription = null;
        }

        this.buffer = Buffer.alloc(0);
        this.isAuthorized = false;
        this.connectedDeviceId = null;

        try {
            const isConnected = await this.manager.isDeviceConnected(deviceId);
            if (!isConnected) {
                this.log('Device already disconnected.');
                return;
            }

            await this.manager.cancelDeviceConnection(deviceId);
            this.log('Device disconnected successfully.');
        } catch (e: any) {
            this.log(`Disconnect Warning: ${e?.message || e}`);
        }
    }

    public createCommand(commandByte: number, payload: number[] = []): string {
        const frame = [0xAA, 0x55, 0x90, 0xEB];
        frame.push(commandByte);
        frame.push(payload.length);
        frame.push(...payload);

        while (frame.length < 19) {
            frame.push(0x00);
        }

        let checksum = 0;
        for (const byte of frame) {
            checksum += byte;
        }
        frame.push(checksum & 0xFF);

        return Buffer.from(frame).toString('base64');
    }

    public async sendCommand(deviceId: string, commandByte: number, payload: number[] = []): Promise<void> {
        const commandBase64 = this.createCommand(commandByte, payload);
        try {
            await this.manager.writeCharacteristicWithResponseForDevice(
                deviceId,
                BleService.SERVICE_UUID,
                BleService.WRITE_UUID,
                commandBase64
            );
        } catch (e: any) {
            this.log(`TX Error: ${e?.message || e}`);
            throw e;
        }
    }

    public async sendAuthorization(deviceId: string, password: string): Promise<void> {
        this.log(`Authorizing...`);
        const passwordBytes = Array.from(Buffer.from(password, 'utf-8'));
        await this.sendCommand(deviceId, 0x05, passwordBytes);
        await new Promise(resolve => setTimeout(resolve, 500));
        this.isAuthorized = true;
    }

    public async sendControlCommand(deviceId: string, register: number, value: number): Promise<void> {
        if (!this.isAuthorized && this.setupPasscode) {
            await this.sendAuthorization(deviceId, this.setupPasscode);
        }
        this.log(`Control: reg=0x${register.toString(16)}, val=${value}`);
        await this.sendCommand(deviceId, register, [value]);
        await new Promise(resolve => setTimeout(resolve, 500));
        // Refresh status
        await this.sendCommand(deviceId, 0x96);
    }
}

export default BleService.getInstance();
