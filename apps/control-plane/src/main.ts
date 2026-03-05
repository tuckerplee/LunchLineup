import express from 'express';
import { ConfigLoader } from '@lunchlineup/config';

const app = express();
const port = 3001;

app.use(express.json());

app.get('/api/status', (req, res) => {
    res.json({
        status: 'RUNNING',
        services: [
            { name: 'api', status: 'ONLINE' },
            { name: 'web', status: 'ONLINE' },
            { name: 'postgres', status: 'ONLINE' }
        ]
    });
});

app.listen(port, () => {
    console.log(`Control Plane listening at http://localhost:${port}`);
});
