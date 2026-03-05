"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const app = (0, express_1.default)();
const port = 3001;
app.use(express_1.default.json());
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
//# sourceMappingURL=main.js.map