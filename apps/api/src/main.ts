import { requireOrdinaryProducer } from './common/pilot-producer-admission';

// This check precedes loading telemetry, AppModule, constructors and module hooks.
requireOrdinaryProducer('full API startup: complete producer admission remains pending');
void import('./ordinary-bootstrap').then(({ bootstrap }) => bootstrap());
