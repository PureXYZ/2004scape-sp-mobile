// The local mock of the Messages API (web/test/lm/mock-claude.mjs) for a device: the app talks to 127.0.0.1:<devicePort>
// on the device, which `adb reverse` carries to the mock on this Mac. The Mac's port is the first free one from
// `firstHostPort`, so a mock another test or agent keeps on the usual port (47591) does not stop this run; the device's
// port is the one baked into a test build (drive.mjs's lm-mock.txt) or passed to an instrumented test, and each device
// has its own.
import { startMockClaude } from '../../../web/test/lm/mock-claude.mjs';

export async function mockBehindReverse(device, { devicePort = 47591, firstHostPort = devicePort, slowMs = 10000 } = {}) {
    for (let hostPort = firstHostPort; hostPort < firstHostPort + 20; hostPort++) {
        let mock;
        try {
            mock = await startMockClaude({ port: hostPort, slowMs });
        } catch (error) {
            if (error?.code === 'EADDRINUSE') continue;
            throw error;
        }
        device.adb('reverse', `tcp:${devicePort}`, `tcp:${hostPort}`);
        return {
            ...mock,
            hostPort,
            deviceUrl: `http://127.0.0.1:${devicePort}/v1/messages`,
            close: async () => {
                device.adbQuiet('reverse', '--remove', `tcp:${devicePort}`);
                await mock.close();
            }
        };
    }
    throw new Error(`no free port for the mock Messages API from ${firstHostPort}`);
}
