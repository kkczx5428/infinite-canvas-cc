import { Suspense } from "react";

import CanvasClientPage from "./canvas-client-page";

export default function CanvasPage() {
    return (
        <Suspense fallback={null}>
            <CanvasClientPage />
        </Suspense>
    );
}
