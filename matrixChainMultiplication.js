/**
 * Matrix Chain Multiplication - Dynamic Programming Solution
 * Determines the optimal order to multiply a chain of matrices
 * to minimize the number of scalar multiplications
 */

/**
 * MATRIX-CHAIN-ORDER algorithm
 * @param {Array} p - Array where p[i-1] x p[i] are dimensions of matrix A_i
 * @returns {Object} - Object containing m (cost table) and s (split table)
 */
function matrixChainOrder(p) {
    const n = p.length - 1; // number of matrices
    
    // Initialize m and s tables
    // m[i][j] = minimum number of multiplications needed to compute A_i...A_j
    // s[i][j] = index k where optimal split occurs
    const m = Array(n + 1).fill(null).map(() => Array(n + 1).fill(0));
    const s = Array(n + 1).fill(null).map(() => Array(n + 1).fill(0));
    
    // Cost is zero when multiplying one matrix
    for (let i = 1; i <= n; i++) {
        m[i][i] = 0;
    }
    
    // l is the chain length
    for (let l = 2; l <= n; l++) {
        for (let i = 1; i <= n - l + 1; i++) {
            const j = i + l - 1;
            m[i][j] = Infinity;
            
            // Try all possible split points
            for (let k = i; k <= j - 1; k++) {
                // q = cost of multiplying A_i...A_k + cost of A_(k+1)...A_j
                //     + cost of multiplying the two resulting matrices
                const q = m[i][k] + m[k + 1][j] + p[i - 1] * p[k] * p[j];
                
                if (q < m[i][j]) {
                    m[i][j] = q;
                    s[i][j] = k;
                }
            }
        }
    }
    
    return { m, s };
}

/**
 * Print the optimal parenthesization
 * @param {Array} s - Split table from matrixChainOrder
 * @param {number} i - Start index
 * @param {number} j - End index
 * @returns {string} - String representation of optimal parenthesization
 */
function printOptimalParens(s, i, j) {
    if (i === j) {
        return `A${i}`;
    } else {
        const k = s[i][j];
        const left = printOptimalParens(s, i, k);
        const right = printOptimalParens(s, k + 1, j);
        return `(${left} × ${right})`;
    }
}

/**
 * Validate matrix chain dimensions
 * @param {Array} dimensions - Array of matrix dimensions [rows, cols] pairs
 * @returns {boolean} - True if matrices can be multiplied in sequence
 */
function validateMatrixChain(dimensions) {
    if (dimensions.length < 2) {
        console.log("Need at least 2 matrices to form a chain");
        return false;
    }
    
    for (let i = 0; i < dimensions.length - 1; i++) {
        const [rows1, cols1] = dimensions[i];
        const [rows2, cols2] = dimensions[i + 1];
        
        if (cols1 !== rows2) {
            console.log(`Error: Matrix ${i + 1} (${rows1}×${cols1}) cannot be multiplied with Matrix ${i + 2} (${rows2}×${cols2})`);
            console.log(`Columns of Matrix ${i + 1} (${cols1}) must equal rows of Matrix ${i + 2} (${rows2})`);
            return false;
        }
    }
    
    return true;
}

/**
 * Convert matrix dimensions to p array format
 * @param {Array} dimensions - Array of [rows, cols] pairs
 * @returns {Array} - p array for algorithm
 */
function dimensionsToP(dimensions) {
    const p = [dimensions[0][0]];
    for (let i = 0; i < dimensions.length; i++) {
        p.push(dimensions[i][1]);
    }
    return p;
}

// ============ Example Usage ============

// Example 1: Chain of 4 matrices
console.log("=== Example 1: Chain of 4 matrices ===");
const matrices1 = [
    [15, 5],  // A1: 30×35
    [5, 10],  // A2: 35×15
    [10, 20],   // A3: 15×5
    [20, 25],    // A4: 5×10
    [25, 10],    // A4: 5×10
];

if (validateMatrixChain(matrices1)) {
    const p1 = dimensionsToP(matrices1);
    console.log("Matrix dimensions:", matrices1.map((m, i) => `A${i + 1}(${m[0]}×${m[1]})`).join(", "));
    console.log("p array:", p1);
    
    const result1 = matrixChainOrder(p1);
    console.log("\nMinimum multiplications needed:", result1.m[1][matrices1.length]);
    console.log("Optimal parenthesization:", printOptimalParens(result1.s, 1, matrices1.length));
    console.log("\nCost table m:");
    for (let i = 1; i <= matrices1.length; i++) {
        console.log(result1.m[i].slice(1).map(v => v === Infinity ? "∞" : v.toString().padStart(6)).join(" "));
    }
}

console.log("\n" + "=".repeat(50) + "\n");

// Example 2: Chain of 6 matrices
console.log("=== Example 2: Chain of 6 matrices ===");
const matrices2 = [
    [10, 20],  // A1: 10×20
    [20, 30],  // A2: 20×30
    [30, 40],  // A3: 30×40
    [40, 30],  // A4: 40×30
    [30, 20],  // A5: 30×20
    [20, 10]   // A6: 20×10
];

if (validateMatrixChain(matrices2)) {
    const p2 = dimensionsToP(matrices2);
    console.log("Matrix dimensions:", matrices2.map((m, i) => `A${i + 1}(${m[0]}×${m[1]})`).join(", "));
    
    const result2 = matrixChainOrder(p2);
    console.log("\nMinimum multiplications needed:", result2.m[1][matrices2.length]);
    console.log("Optimal parenthesization:", printOptimalParens(result2.s, 1, matrices2.length));
}

console.log("\n" + "=".repeat(50) + "\n");

// Example 3: Invalid chain (incompatible dimensions)
console.log("=== Example 3: Invalid chain test ===");
const matrices3 = [
    [10, 20],  // A1: 10×20
    [30, 40],  // A2: 30×40 (incompatible: 20 ≠ 30)
    [40, 50]   // A3: 40×50
];

validateMatrixChain(matrices3);

// Export functions for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        matrixChainOrder,
        printOptimalParens,
        validateMatrixChain,
        dimensionsToP
    };
}
