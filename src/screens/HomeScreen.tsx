
import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, PermissionsAndroid, Platform, Alert, ActivityIndicator } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RootStackParamList } from '../../App';
import BleService, { JKBMSDevice } from '../services/BleService';
import RemoteLogger from '../services/RemoteLogger';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RNRestart from 'react-native-restart';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

const AUTO_SCAN_KEY = 'JK_TOOL_AUTO_SCAN';
const TARGET_DEVICE_KEY = 'JK_TOOL_TARGET_DEVICE';
let hasConnectedSession = false; // V22: Track if we've initiated a connection in this session

export default function HomeScreen({ navigation }: Props) {
    const [devices, setDevices] = useState<JKBMSDevice[]>([]);
    const [scanning, setScanning] = useState(false);
    const [permissionGranted, setPermissionGranted] = useState(false);
    const [autoScanPending, setAutoScanPending] = useState(false); // V21: New State

    useEffect(() => {
        requestPermissions();
        checkAutoScan();

        const handleDeviceFound = (device: JKBMSDevice) => {
            setDevices(prev => {
                const exists = prev.find(d => d.id === device.id);
                if (!exists) return [...prev, device];
                return prev;
            });
        };

        const handleScanStop = () => {
            setScanning(false);
        };

        BleService.on('deviceFound', handleDeviceFound);
        BleService.on('scanStop', handleScanStop);

        return () => {
            BleService.off('deviceFound', handleDeviceFound);
            BleService.off('scanStop', handleScanStop);
            BleService.stopScan();
        };
    }, []);

    // V21: Effect to trigger scan ONLY when permissions are ready
    useEffect(() => {
        if (autoScanPending && permissionGranted) {
            console.log("V21: Auto-Scan Triggered (Permissions Ready)");
            setAutoScanPending(false);
            setTimeout(() => {
                startScan();
            }, 500); // Small delay to let UI settle
        }
    }, [autoScanPending, permissionGranted]);

    const checkAutoScan = async () => {
        try {
            // V22: Check for Target Device (Restart-and-Connect Strategy)
            const targetDeviceJson = await AsyncStorage.getItem(TARGET_DEVICE_KEY);
            if (targetDeviceJson) {
                RemoteLogger.log('Target Device found. Auto-connecting...');
                await AsyncStorage.removeItem(TARGET_DEVICE_KEY);
                const targetDevice = JSON.parse(targetDeviceJson);

                // Mark session as dirty immediately
                hasConnectedSession = true;

                // Allow UI to settle then navigate
                setTimeout(() => {
                    navigation.navigate('DeviceDetail', { device: targetDevice });
                }, 500);
                return;
            }

            const autoScan = await AsyncStorage.getItem(AUTO_SCAN_KEY);
            if (autoScan === 'true') {
                RemoteLogger.log('Auto-Scan flag found. Waiting for permissions...');
                await AsyncStorage.removeItem(AUTO_SCAN_KEY);
                setAutoScanPending(true); // V21: Set pending state instead of immediate timeout
            }
        } catch (e) { }
    };

    const requestPermissions = async () => {
        if (Platform.OS === 'android') {
            try {
                const granted = await PermissionsAndroid.requestMultiple([
                    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
                    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
                    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
                ]);

                const allGranted = Object.values(granted).every(
                    (result) => result === PermissionsAndroid.RESULTS.GRANTED
                );

                if (allGranted) {
                    setPermissionGranted(true);
                } else {
                    Alert.alert('Permission Denied', 'Bluetooth permissions are required.');
                }
            } catch (err) {
                console.warn(err);
            }
        } else {
            setPermissionGranted(true);
        }
    };

    const startScan = async () => {
        if (!permissionGranted) {
            requestPermissions();
            return;
        }

        try {
            // Check for dirty connections (V17 Logic)
            const connectedDevices = await BleService.getConnectedDevices();
            if (connectedDevices.length > 0) {
                RemoteLogger.log('Dirty connection found (' + connectedDevices[0].id + '). Nuking app...');
                await AsyncStorage.setItem(AUTO_SCAN_KEY, 'true');
                RNRestart.Restart();
                return;
            }

            setDevices([]);
            setScanning(true);
            await BleService.startScan();
        } catch (error) {
            console.log(error);
            Alert.alert('Error', 'Failed to start scan: ' + String(error));
            setScanning(false);
        }
    };

    const connectToDevice = async (device: JKBMSDevice) => {
        if (scanning) {
            BleService.stopScan();
        }

        // V22: Restart-and-Connect Strategy
        // If we have already connected to a device in this session, 
        // we must RESTART the app to clear the BLE stack before connecting to another (or the same) one.
        if (hasConnectedSession) {
            try {
                // Save target device
                // storage only needs id and name. deviceObject is not serializable/needed for connection start
                const minimalDevice = { id: device.id, name: device.name, rssi: device.rssi };
                await AsyncStorage.setItem(TARGET_DEVICE_KEY, JSON.stringify(minimalDevice));
                RNRestart.Restart();
            } catch (e) {
                Alert.alert("Error", "Failed to restart for connection.");
            }
            return;
        }

        hasConnectedSession = true;
        navigation.navigate('DeviceDetail', { device });
    };

    const renderItem = ({ item }: { item: JKBMSDevice }) => (
        <TouchableOpacity
            style={styles.deviceItem}
            onPress={() => connectToDevice(item)}
        >
            <View>
                <Text style={styles.deviceName}>{item.name || 'Unknown Device'}</Text>
                {/* V20: Hide MAC Address */}
                {/* <Text style={styles.deviceId}>{item.id}</Text> */}
            </View>
            <Text style={styles.rssi}>RSSI: {item.rssi}</Text>
        </TouchableOpacity>
    );

    return (
        <SafeAreaView style={styles.container} edges={['bottom', 'left', 'right']}>
            <FlatList
                data={devices}
                renderItem={renderItem}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.listContent}
                ListEmptyComponent={
                    !scanning ? (
                        <View style={styles.emptyContainer}>
                            <Text style={styles.emptyText}>No devices found. Press Scan.</Text>
                        </View>
                    ) : null
                }
            />

            <View style={styles.footer}>
                <TouchableOpacity
                    style={[styles.scanButton, scanning && styles.scanButtonScanning]}
                    onPress={startScan}
                    disabled={scanning}
                >
                    {scanning ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <ActivityIndicator color='#FFF' style={{ marginRight: 10 }} />
                            <Text style={styles.scanButtonText}>Scanning...</Text>
                        </View>
                    ) : (
                        <Text style={styles.scanButtonText}>Scan Devices</Text>
                    )}
                </TouchableOpacity>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F5F5F5',
    },
    listContent: {
        padding: 10,
    },
    deviceItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 15,
        backgroundColor: '#FFFFFF',
        marginBottom: 10,
        borderRadius: 8,
        elevation: 2,
    },
    deviceName: {
        fontSize: 16,
        fontWeight: 'bold',
        color: '#333',
        fontFamily: 'Krub_700Bold', // V21 Font
    },
    deviceId: {
        fontSize: 12,
        color: '#666',
        fontFamily: 'Krub_400Regular', // V21 Font
    },
    rssi: {
        fontSize: 14,
        color: '#999',
        fontFamily: 'Krub_500Medium', // V21 Font
    },
    emptyContainer: {
        padding: 40,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 16,
        color: '#999',
        fontFamily: 'Krub_400Regular', // V21 Font
    },
    footer: {
        padding: 20,
        backgroundColor: '#FFF',
        elevation: 8,
    },
    scanButton: {
        backgroundColor: '#007AFF', // Standard Blue
        paddingVertical: 15,
        borderRadius: 30, // Rounded V18 style
        alignItems: 'center',
        justifyContent: 'center',
    },
    scanButtonScanning: {
        backgroundColor: '#999',
    },
    scanButtonText: {
        color: '#FFF',
        fontSize: 18,
        fontWeight: 'bold',
        fontFamily: 'Krub_700Bold', // V21 Font
    },
});
