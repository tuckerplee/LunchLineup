<?php
declare(strict_types=1);

?>

    <!-- Employee Edit Modal -->
    <div id="employeeEditModal" class="modal hidden">
        <div class="modal-content">
            <h3 class="text-lg font-bold mb-4">Edit Employee</h3>
            <div class="mb-4">
                <label class="block text-gray-700 text-sm font-bold mb-2" for="employeeName">
                    Employee Name:
                </label>
                <input id="employeeName" type="text" class="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline">
            </div>
            <div class="flex justify-end space-x-2">
                <button id="cancelEmployeeEdit" class="btn btn-secondary font-bold py-2 px-4 rounded">
                    Cancel
                </button>
                <button id="saveEmployeeEdit" class="btn btn-primary font-bold py-2 px-4 rounded">
                    Save
                </button>
            </div>
        </div>
    </div>

    <!-- Shift Edit Modal -->
    <div id="shiftEditModal" class="modal hidden">
        <div class="modal-content">
            <h3 class="text-lg font-bold mb-4">Edit Shift Time</h3>
            <div class="mb-4">
                <p class="text-gray-700 mb-2">Employee: <span id="shiftEditEmployee" class="font-bold"></span></p>
                <div class="flex items-center space-x-2 mb-4">
                    <label class="text-gray-700 text-sm font-bold" for="shiftStartTime">
                        Start Time:
                    </label>
                    <input id="shiftStartTime" type="time" class="shadow appearance-none border rounded py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline">
                </div>
                <div class="flex items-center space-x-2">
                    <label class="text-gray-700 text-sm font-bold" for="shiftEndTime">
                        End Time:
                    </label>
                    <input id="shiftEndTime" type="time" class="shadow appearance-none border rounded py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline">
                </div>
                <div class="mt-4 text-sm text-gray-600">
                    <p>Break times will be automatically adjusted based on shift duration.</p>
                </div>
            </div>
            <div class="flex justify-end space-x-2">
                <button id="cancelShiftEdit" class="btn btn-secondary font-bold py-2 px-4 rounded">
                    Cancel
                </button>
                <button id="saveShiftEdit" class="btn btn-primary font-bold py-2 px-4 rounded">
                    Save Shift
                </button>
            </div>
        </div>
    </div>

    <!-- POS Edit Modal -->
    <div id="posEditModal" class="modal hidden">
        <div class="modal-content">
            <h3 class="text-lg font-bold mb-4">Edit POS Number</h3>
            <div class="mb-4">
                <p class="text-gray-700 mb-2">Employee: <span id="posEditEmployee" class="font-bold"></span></p>
                <div class="flex items-center space-x-2">
                    <label class="text-gray-700 text-sm font-bold" for="posNumber">
                        POS #:
                    </label>
                    <input id="posNumber" type="number" min="1" max="20" class="shadow appearance-none border rounded py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline w-20">
                </div>
            </div>
            <div class="flex justify-end space-x-2">
                <button id="cancelPosEdit" class="btn btn-secondary font-bold py-2 px-4 rounded">
                    Cancel
                </button>
                <button id="savePosEdit" class="btn btn-primary font-bold py-2 px-4 rounded">
                    Save
                </button>
            </div>
        </div>
    </div>

    <!-- Break Edit Modal -->
    <div id="breakEditModal" class="modal hidden">
        <div class="modal-content">
            <h3 class="text-lg font-bold mb-4">Edit Break Times</h3>
            <div class="mb-4">
                <p class="text-gray-700 mb-2">Employee: <span id="breakEditEmployee" class="font-bold"></span></p>
                
                <div class="border-b pb-3 mb-3">
                    <div class="flex items-center justify-between mb-2">
                        <h4 class="font-bold text-gray-700">Break 1</h4>
                        <label class="flex items-center text-sm text-gray-600">
                            <input id="break1Skip" type="checkbox" class="mr-2">
                            <span>Skip</span>
                        </label>
                    </div>
                    <div class="flex items-center space-x-2 mb-2">
                        <label class="text-gray-700 text-sm w-16" for="break1Time">Time:</label>
                        <input id="break1Time" type="time" class="shadow appearance-none border rounded py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline">
                    </div>
                </div>

                <div class="border-b pb-3 mb-3">
                    <div class="flex items-center justify-between mb-2">
                        <h4 class="font-bold text-gray-700">Lunch</h4>
                        <label class="flex items-center text-sm text-gray-600">
                            <input id="lunchSkip" type="checkbox" class="mr-2">
                            <span>Skip</span>
                        </label>
                    </div>
                    <div class="flex items-center space-x-2 mb-2">
                        <label class="text-gray-700 text-sm w-16" for="lunchTime">Time:</label>
                        <input id="lunchTime" type="time" class="shadow appearance-none border rounded py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline">
                    </div>
                    <div class="flex items-center space-x-2">
                        <label class="text-gray-700 text-sm w-16" for="lunchDuration">Duration:</label>
                        <select id="lunchDuration" class="shadow border rounded py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline">
                            <option value="10">10 min</option>
                            <option value="15">15 min</option>
                            <option value="30" selected>30 min</option>
                            <option value="45">45 min</option>
                            <option value="60">60 min</option>
                        </select>
                    </div>
                </div>
                
                <div>
                    <div class="flex items-center justify-between mb-2">
                        <h4 class="font-bold text-gray-700">Break 2</h4>
                        <label class="flex items-center text-sm text-gray-600">
                            <input id="break2Skip" type="checkbox" class="mr-2">
                            <span>Skip</span>
                        </label>
                    </div>
                    <div class="flex items-center space-x-2 mb-2">
                        <label class="text-gray-700 text-sm w-16" for="break2Time">Time:</label>
                        <input id="break2Time" type="time" class="shadow appearance-none border rounded py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline">
                    </div>
                </div>
                
                <div class="mt-4 text-sm text-blue-600">
                    <p>Note: Break times will be shown in the timeline to help avoid conflicts.</p>
                </div>
            </div>
            <div class="flex justify-end space-x-2">
                <button id="cancelBreakEdit" class="btn btn-secondary font-bold py-2 px-4 rounded">
                    Cancel
                </button>
                <button id="saveBreakEdit" class="btn btn-primary font-bold py-2 px-4 rounded">
                    Save Breaks
                </button>
            </div>
        </div>
    </div>

    <!-- Clear Schedule Modal -->
    <div id="clearScheduleModal" class="modal hidden">
        <div class="modal-content">
            <h3 class="text-lg font-bold mb-4">Clear Schedule</h3>
            <p class="mb-4">Are you sure you want to clear the current schedule?</p>
            <div class="flex justify-end space-x-2">
                <button id="cancelClearSchedule" class="btn btn-secondary font-bold py-2 px-4 rounded">Cancel</button>
                <button id="confirmClearSchedule" class="btn btn-primary font-bold py-2 px-4 rounded">Confirm</button>
            </div>
        </div>
    </div>

    <!-- Import Schedule Modal -->
    <div id="importScheduleModal" class="modal hidden">
        <div class="modal-content">
            <h3 class="text-lg font-bold mb-4">Import Schedule</h3>
            <p class="mb-2">Select which days to import:</p>
            <div id="importScheduleList" class="mb-4"></div>
            <div class="flex justify-end space-x-2">
                <button id="cancelImportSchedule" class="btn btn-secondary font-bold py-2 px-4 rounded">Cancel</button>
                <button id="confirmImportSchedule" class="btn btn-primary font-bold py-2 px-4 rounded">Import</button>
            </div>
        </div>
    </div>
