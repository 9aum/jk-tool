
export const REMOTE_LOG_URL = 'https://9aum.com/app/log.php';

class RemoteLogger {
    static async log(message: string) {
        try {
            // Also log to console for development
            console.log(message);

            // V22: Remote Logging Disabled
            // await fetch(REMOTE_LOG_URL, {
            //     method: 'POST',
            //     headers: {
            //         'Content-Type': 'application/json',
            //     },
            //     body: JSON.stringify({ message }),
            // });
        } catch (error) {
            console.error('Failed to send log:', error);
        }
    }
}

export default RemoteLogger;
