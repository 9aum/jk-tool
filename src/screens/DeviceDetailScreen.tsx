
import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Alert, ScrollView, TouchableOpacity, Modal } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RootStackParamList } from '../../App';
import BleService from '../services/BleService';
import RemoteLogger from '../services/RemoteLogger';
import { Buffer } from 'buffer';

type Props = NativeStackScreenProps<RootStackParamList, 'DeviceDetail'>;

// Helper: Convert Buffer to ASCII string
function bufferToAscii(buf: Buffer): string {
    let result = '';
    for (let i = 0; i < buf.length; i++) {
        const byte = buf[i];
        if (byte === 0) break;
        result += String.fromCharCode(byte);
    }
    return result;
}

// Helper: Read 32-bit Little Endian Integer from Buffer
function readUInt32LE(buf: Buffer, offset: number): number {
    return (buf[offset]) | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
}

// Card V18
function Card({ children, title }: { children: React.ReactNode, title?: string }) {
    return (
        <View style={styles.card}>
            {title && <Text style={styles.cardTitle}>{title}</Text>}
            <View style={styles.cardContent}>
                {children}
            </View>
        </View>
    );
}

// Passcode Card V18
function PasscodeCard({ label, value }: { label: string; value: string }) {
    const [revealed, setRevealed] = useState(false);
    return (
        <TouchableOpacity style={styles.passcodeItem} onPress={() => setRevealed(!revealed)}>
            <Text style={styles.passcodeLabel}>{label}</Text>
            <Text style={styles.passcodeValue}>{revealed ? value : '••••'}</Text>
        </TouchableOpacity>
    );
}

// Stat Box V18
function StatBox({ label, value, unit }: { label: string; value: string; unit: string }) {
    return (
        <View style={styles.statBox}>
            <Text style={styles.statLabel}>{label}</Text>
            <Text style={styles.statValue}>{value} <Text style={styles.statUnit}>{unit}</Text></Text>
        </View>
    );
}

// Status Indicator V18
function StatusIndicator({ label, isActive, onPress }: { label: string; isActive: boolean | null; onPress?: () => void }) {
    if (isActive === null) return null;
    return (
        <TouchableOpacity
            style={[styles.statusBadge, isActive ? styles.statusActive : styles.statusInactive]}
            onPress={onPress}
            activeOpacity={0.7}
        >
            <Text style={styles.statusText} numberOfLines={1} adjustsFontSizeToFit>
                {label}: {isActive ? 'ON' : 'OFF'}
            </Text>
        </TouchableOpacity>
    );
}

export default function DeviceDetailScreen({ route, navigation }: Props) {
    const { device } = route.params;
    const [connecting, setConnecting] = useState(true);
    const [connected, setConnected] = useState(false);
    const [status, setStatus] = useState('Connecting...');

    // Passcodes
    const [devicePasscode, setDevicePasscode] = useState<string>('-');
    const [passcode, setPasscode] = useState<string>('-');
    const [setupPasscode, setSetupPasscode] = useState<string>('-');

    // V18 New Stats
    const [totalVoltage, setTotalVoltage] = useState<string>('-');
    const [capacityRemaining, setCapacityRemaining] = useState<string>('-');
    const [nominalCapacity, setNominalCapacity] = useState<string>('-');
    const [cycles, setCycles] = useState<string>('-');

    // Status
    const [chargeStatus, setChargeStatus] = useState<boolean | null>(null);
    const [dischargeStatus, setDischargeStatus] = useState<boolean | null>(null);

    const [nuking, setNuking] = useState(false);
    const [modalVisible, setModalVisible] = useState(false);
    const [modalConfig, setModalConfig] = useState<any>({});

    const mountedRef = useRef(true);
    const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const stopPolling = () => {
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }
    };

    const chargeStatusRef = useRef<boolean | null>(null);
    const dischargeStatusRef = useRef<boolean | null>(null);

    useEffect(() => {
        chargeStatusRef.current = chargeStatus;
    }, [chargeStatus]);

    useEffect(() => {
        dischargeStatusRef.current = dischargeStatus;
    }, [dischargeStatus]);

    useEffect(() => {
        RemoteLogger.log('DeviceDetail: useEffect mount');
        mountedRef.current = true;

        const handleData = ({ type, data }: { type: number; data: Buffer }) => {
            if (!mountedRef.current) return;
            try {
                if (type === 0x03) {
                    if (data.length >= 134) {
                        const devPass = bufferToAscii(Buffer.from(data.slice(62, 62 + 16)));
                        const pass = bufferToAscii(Buffer.from(data.slice(97, 97 + 5)));
                        const setupPass = bufferToAscii(Buffer.from(data.slice(118, 118 + 16)));

                        setDevicePasscode(devPass || '-');
                        setPasscode(pass || '-');
                        setSetupPasscode(setupPass || '-');
                        BleService.setSetupPasscode(setupPass);

                        const vendorId = bufferToAscii(Buffer.from(data.slice(6, 6 + 16)));
                        const swVer = bufferToAscii(Buffer.from(data.slice(30, 30 + 8)));

                        // Protocol Offset Logic
                        if (vendorId.startsWith('JK_BD') || swVer.startsWith('11.')) {
                            BleService.setProtocolOffset(32);
                        } else if (vendorId.startsWith('JK_B2A') || vendorId.includes('32S')) {
                            BleService.setProtocolOffset(16);
                        } else {
                            BleService.setProtocolOffset(0);
                        }
                    }
                } else if (type === 0x02) {
                    const offset = BleService.getProtocolOffset();

                    if (data.length > 118 + offset + 4) {
                        const v = readUInt32LE(data, 118 + offset) * 0.001;
                        setTotalVoltage(v.toFixed(2));
                    }
                    if (data.length > 142 + offset + 4) {
                        const ah = readUInt32LE(data, 142 + offset) * 0.001;
                        setCapacityRemaining(ah.toFixed(1));
                    }
                    if (data.length > 146 + offset + 4) {
                        const cap = readUInt32LE(data, 146 + offset) * 0.001;
                        setNominalCapacity(cap.toFixed(0));
                    }
                    if (data.length > 150 + offset + 4) {
                        const cyc = readUInt32LE(data, 150 + offset);
                        setCycles(cyc.toString());
                    }

                    const chargeIdx = 166 + offset;
                    const dischargeIdx = 167 + offset;

                    if (data.length > Math.max(chargeIdx, dischargeIdx)) {
                        setChargeStatus(data[chargeIdx] === 1);
                        setDischargeStatus(data[dischargeIdx] === 1);
                    }
                }
            } catch (err) { }
        };

        BleService.on('data', handleData);
        checkConnectionAndStart();

        return () => {
            mountedRef.current = false;
            stopPolling();
            BleService.off('data', handleData);
        };
    }, []);

    const checkConnectionAndStart = async () => {
        try {
            BleService.stopScan();
            if (BleService.connectedDeviceId && BleService.connectedDeviceId !== device.id) {
                setStatus('Switching device...');
                await BleService.disconnect(BleService.connectedDeviceId);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            const isAlreadyConnected = await BleService.isDeviceConnected(device.id);
            if (isAlreadyConnected && mountedRef.current) {
                BleService.connectedDeviceId = device.id;
                startSession();
            } else {
                connectToDevice();
            }
        } catch (e) { connectToDevice(); }
    };

    const startSession = async () => {
        setConnected(true);
        setStatus('Connected');
        setConnecting(false);

        setTimeout(async () => { if (mountedRef.current) await safeSendCommand(0x97); }, 500);
        setTimeout(async () => { if (mountedRef.current) await safeSendCommand(0x96); }, 1500);

        pollIntervalRef.current = setInterval(async () => {
            if (mountedRef.current) await safeSendCommand(0x96);
        }, 2000);
    };

    const connectToDevice = async () => {
        try {
            setStatus('Connecting...');
            await BleService.connect(device.id);
            if (!mountedRef.current) return;
            startSession();
        } catch (error: any) {
            if (!mountedRef.current) return;
            if (error.message && (error.message.includes('already connected') || error.message.includes('Device is connected'))) {
                startSession();
            } else {
                Alert.alert('Connection Failed', String(error), [{ text: 'Back', onPress: () => navigation.goBack() }]);
            }
        } finally {
            if (mountedRef.current) setConnecting(false);
        }
    };

    const safeSendCommand = async (cmd: number) => {
        try { await BleService.sendCommand(device.id, cmd); } catch (e) { }
    };

    const sendRobustCommand = async (register: number, value: number, currentStatusRef: React.MutableRefObject<boolean | null>) => {
        const targetBool = value === 1;

        for (let i = 0; i < 3; i++) {
            try {
                // Determine if we need to send
                // Reading ref directly to skip if already in state? User said "if status not changed, retry"
                // So always send first then check.

                // We use BleService.sendControlCommand BUT we want longer delay.
                // BleService.sendControlCommand waits 500ms then refreshes.
                // User wants 3.5s delay. 

                await BleService.sendControlCommand(device.id, register, value);

                setStatus(`Verifying ${i + 1}/3...`);
                // Wait 3.5s (Requested adjustment)
                await new Promise(resolve => setTimeout(resolve, 3500));

                // Force Refresh status just in case
                await safeSendCommand(0x96);

                // Wait distinct time for data to arrive
                await new Promise(resolve => setTimeout(resolve, 1000));

                if (currentStatusRef.current === targetBool) {
                    return true;
                }
            } catch (e) {
                console.log("Retry error", e);
            }
        }
        return false;
    };

    const confirmNuke = async () => {
        setModalVisible(false);
        setNuking(true);
        const { targetState } = modalConfig;

        try {
            setStatus('Executing Charge...');
            const chargeSuccess = await sendRobustCommand(0x1d, targetState, chargeStatusRef);

            setStatus('Executing Discharge...');
            const dischargeSuccess = await sendRobustCommand(0x1e, targetState, dischargeStatusRef);

            if (!chargeSuccess || !dischargeSuccess) {
                // Option: Alert user if failed after 3 tries
                // Alert.alert("Notice", "Some commands required multiple retries or failed. Check status.");
            }

        } catch (e) {
            Alert.alert('Error', String(e));
        } finally {
            setStatus('Connected');
            setNuking(false);
        }
    };

    const handleToggleSingle = (type: 'charge' | 'discharge') => {
        if (nuking) return;

        const isCharge = type === 'charge';
        const currentVal = isCharge ? chargeStatus : dischargeStatus;
        if (currentVal === null) return;

        const targetState = currentVal ? 0 : 1;
        const action = currentVal ? "Disable" : "Enable";
        const label = isCharge ? "Charge" : "Discharge";

        setModalConfig({
            title: `${action} ${label}`,
            message: `Are you sure you want to ${action.toUpperCase()} ${label}?`,
            targetState: targetState,
            color: currentVal ? 'red' : 'green',
        });

        // We override the confirm function for this specific modal instance or use a flag?
        // Reuse confirmNuke logic but maybe we need single mode.
        // Actually, confirmNuke iterates simply.
        // Let's make a specific single confirm function or pass a param.
        // Easiest is to make a specific function for the modal confirm button.

        // Quick Refactor: Store 'mode' in modalConfig
        // mode: 'all' | 'charge' | 'discharge'

        setModalVisible(true);
    };

    const handleNukePress = () => {
        if (nuking) return;

        const isAllOn = chargeStatus && dischargeStatus;
        const targetState = isAllOn ? 0 : 1;
        const actionText = isAllOn ? 'DISABLE' : 'ENABLE';
        const title = isAllOn ? "NUKE (Turn OFF)" : "RESTORE (Turn ON)";
        const color = isAllOn ? 'red' : 'green';

        setModalConfig({
            title: title,
            message: `Are you sure you want to ${actionText} Charge & Discharge?`,
            targetState: targetState,
            color: color,
            mode: 'all'
        });
        setModalVisible(true);
    };

    let nukeBtnStyle = { backgroundColor: '#4CD964' }; // Green
    let nukeBtnText = "RESTORE (Enable All)";

    if (chargeStatus && dischargeStatus) {
        nukeBtnStyle = { backgroundColor: '#FF3B30' }; // Red
        nukeBtnText = "NUKE (Disable All)";
    } else if (!chargeStatus && !dischargeStatus) {
        nukeBtnStyle = { backgroundColor: '#4CD964' }; // Green
        nukeBtnText = "RESTORE (Enable All)";
    } else {
        nukeBtnStyle = { backgroundColor: '#FF9500' }; // Orange (Mixed)
        nukeBtnText = "Enable All";
    }

    const nukeDisabled = nuking || chargeStatus === null;

    return (
        <SafeAreaView style={styles.safeArea} edges={['bottom', 'left', 'right']}>
            <View style={styles.container}>
                <ScrollView contentContainerStyle={styles.scrollContent}>
                    {/* V20: Header Removed as per request */}
                    {/* We maintain a small status text maybe? Or just rely on visual indicators */}

                    {connecting && (
                        <View style={styles.loadingContainer}>
                            <ActivityIndicator size="large" color="#007AFF" />
                        </View>
                    )}

                    {connected && (
                        <View style={styles.content}>
                            {/* V20: Status Indicator with Green Dot */}
                            <View style={styles.connectionStatusContainer}>
                                <View style={styles.greenDot} />
                                <Text style={styles.connectionStatusText}>Connected</Text>
                            </View>

                            {/* Row 1: Voltage & Cycles */}
                            <View style={styles.row}>
                                <StatBox label="Total Voltage" value={totalVoltage} unit="V" />
                                <StatBox label="Cycles" value={cycles} unit="" />
                            </View>

                            {/* Row 2: Capacity */}
                            <View style={styles.row}>
                                <StatBox label="Capacity (Set)" value={nominalCapacity} unit="Ah" />
                                <StatBox label="Remaining" value={capacityRemaining} unit="Ah" />
                            </View>

                            {/* Row 3: Passcodes V20 Renamed & Reorganized */}
                            <Card title="Security">
                                <View style={styles.passcodeStack}>
                                    <View style={styles.passcodeRow}>
                                        <PasscodeCard label="Device Passcode" value={devicePasscode} />
                                    </View>
                                    <View style={styles.passcodeRow}>
                                        <PasscodeCard label="Passcode" value={passcode} />
                                        <PasscodeCard label="Setup Passcode" value={setupPasscode} />
                                    </View>
                                </View>
                            </Card>

                            {/* Row 4: Status Buttons V20 */}
                            <View style={styles.statusRow}>
                                <StatusIndicator
                                    label="Charge"
                                    isActive={chargeStatus}
                                    onPress={() => {
                                        setModalConfig({
                                            title: chargeStatus ? "Disable Charge" : "Enable Charge",
                                            message: `Turn ${chargeStatus ? "OFF" : "ON"} Charging?`,
                                            targetState: chargeStatus ? 0 : 1,
                                            color: chargeStatus ? 'red' : 'green',
                                            mode: 'charge'
                                        });
                                        setModalVisible(true);
                                    }}
                                />
                                <View style={{ width: 8 }} /> {/* V22: Spacer Reduced (20 -> 8) */}
                                <StatusIndicator
                                    label="Discharge"
                                    isActive={dischargeStatus}
                                    onPress={() => {
                                        setModalConfig({
                                            title: dischargeStatus ? "Disable Discharge" : "Enable Discharge",
                                            message: `Turn ${dischargeStatus ? "OFF" : "ON"} Discharging?`,
                                            targetState: dischargeStatus ? 0 : 1,
                                            color: dischargeStatus ? 'red' : 'green',
                                            mode: 'discharge'
                                        });
                                        setModalVisible(true);
                                    }}
                                />
                            </View>

                            {/* Footer: Nuke Button */}
                            <TouchableOpacity
                                style={[styles.nukeButton, nukeBtnStyle, nukeDisabled && styles.disabledBtn]}
                                onPress={handleNukePress}
                                disabled={nukeDisabled}
                            >
                                {nuking ? <ActivityIndicator color="#FFF" /> : <Text style={styles.nukeButtonText}>{nukeBtnText}</Text>}
                            </TouchableOpacity>
                        </View>
                    )}
                </ScrollView>

                {/* Standard Modal V18 */}
                <Modal visible={modalVisible} transparent={true} animationType="fade" onRequestClose={() => setModalVisible(false)}>
                    <View style={styles.modalOverlay}>
                        <View style={styles.modalContent}>
                            <Text style={styles.modalTitle}>{modalConfig.title}</Text>
                            <Text style={styles.modalMessage}>{modalConfig.message}</Text>
                            <View style={styles.modalButtons}>
                                <TouchableOpacity style={styles.modalBtnCancel} onPress={() => setModalVisible(false)}>
                                    <Text style={styles.modalBtnTextCancel}>Cancel</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.modalBtnConfirm, { backgroundColor: modalConfig.color === 'red' ? '#FF3B30' : '#4CD964' }]}
                                    onPress={async () => {
                                        if (modalConfig.mode === 'all') {
                                            await confirmNuke();
                                        } else if (modalConfig.mode === 'charge') {
                                            setModalVisible(false);
                                            setNuking(true);
                                            await sendRobustCommand(0x1d, modalConfig.targetState, chargeStatusRef);
                                            setNuking(false);
                                            setStatus('Connected');
                                        } else if (modalConfig.mode === 'discharge') {
                                            setModalVisible(false);
                                            setNuking(true);
                                            await sendRobustCommand(0x1e, modalConfig.targetState, dischargeStatusRef);
                                            setNuking(false);
                                            setStatus('Connected');
                                        }
                                    }}
                                >
                                    <Text style={styles.modalBtnTextConfirm}>Confirm</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    </View>
                </Modal>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: '#F2F2F7' },
    container: { flex: 1 },
    scrollContent: { padding: 16 },
    // V21: Added Fonts
    headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#000', fontFamily: 'Krub_700Bold' },
    headerId: { fontSize: 14, color: '#666', fontFamily: 'Krub_400Regular' },
    status: { fontSize: 16, color: '#007AFF', marginTop: 5, fontFamily: 'Krub_500Medium' },
    loadingContainer: { alignItems: 'center', marginTop: 50 },
    content: {},
    // Connection Status
    connectionStatusContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
    greenDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#34C759', marginRight: 8 },
    connectionStatusText: { fontSize: 18, color: '#34C759', fontWeight: 'bold', fontFamily: 'Krub_700Bold' },

    row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
    statBox: {
        flex: 1, backgroundColor: '#FFF', padding: 16, borderRadius: 12, marginHorizontal: 4,
        alignItems: 'center', justifyContent: 'center', elevation: 2
    },
    statLabel: { fontSize: 12, color: '#8E8E93', marginBottom: 4, fontFamily: 'Krub_400Regular' },
    statValue: { fontSize: 20, fontWeight: 'bold', color: '#000', fontFamily: 'Krub_700Bold' },
    statUnit: { fontSize: 14, color: '#8E8E93', fontFamily: 'Krub_400Regular' },
    card: { backgroundColor: '#FFF', borderRadius: 12, padding: 16, marginBottom: 12, elevation: 2 },
    cardTitle: { fontSize: 14, fontWeight: '600', color: '#8E8E93', marginBottom: 12, fontFamily: 'Krub_500Medium' },
    cardContent: {},
    passcodeStack: { flexDirection: 'column' },
    passcodeRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
    passcodeItem: { alignItems: 'center', flex: 1, paddingHorizontal: 4 },
    passcodeLabel: { fontSize: 10, color: '#8E8E93', textAlign: 'center', fontFamily: 'Krub_400Regular' },
    passcodeValue: { fontSize: 14, fontWeight: 'bold', color: '#007AFF', marginTop: 2, textAlign: 'center', fontFamily: 'Krub_500Medium' },
    statusRow: { flexDirection: 'row', justifyContent: 'center', marginBottom: 20 },
    statusBadge: {
        paddingHorizontal: 8, // V21: Reduced padding from 20 -> 8 to prevent wrapping
        paddingVertical: 10, borderRadius: 8, // Rectangular-ish with rounded corners
        flex: 1, alignItems: 'center', justifyContent: 'center',
        borderWidth: 1, borderColor: 'rgba(0,0,0,0.1)'
    },
    statusActive: { backgroundColor: '#34C759', borderColor: '#2E8B57' }, // Stronger Green
    statusInactive: { backgroundColor: '#FF3B30', borderColor: '#8B0000' }, // Stronger Red
    statusText: { fontWeight: 'bold', color: '#FFF', fontFamily: 'Krub_700Bold', fontSize: 14 }, // V21: Explicit font size
    nukeButton: { padding: 16, borderRadius: 14, alignItems: 'center', elevation: 4 },
    nukeButtonText: { color: '#FFF', fontSize: 18, fontWeight: 'bold', fontFamily: 'Krub_700Bold' },
    disabledBtn: { opacity: 0.6 },
    // Modal
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
    modalContent: { width: '80%', backgroundColor: '#FFF', borderRadius: 14, padding: 20, alignItems: 'center' },
    modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 10, fontFamily: 'Krub_700Bold' },
    modalMessage: { fontSize: 16, textAlign: 'center', marginBottom: 20, color: '#333', fontFamily: 'Krub_400Regular' },
    modalButtons: { flexDirection: 'row', width: '100%' },
    modalBtnCancel: { flex: 1, alignItems: 'center', padding: 12 },
    modalBtnTextCancel: { color: '#007AFF', fontSize: 16, fontFamily: 'Krub_500Medium' },
    modalBtnConfirm: { flex: 1, alignItems: 'center', padding: 12, borderRadius: 8 },
    modalBtnTextConfirm: { color: '#FFF', fontSize: 16, fontWeight: 'bold', fontFamily: 'Krub_700Bold' }
});
