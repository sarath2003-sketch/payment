import React, { useState } from 'react';
import { importExport } from '../services/api';

function ImportExport() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [importResult, setImportResult] = useState(null);

  const handleFileSelect = (e) => {
    setFile(e.target.files[0]);
    setError('');
  };

  const handleImport = async () => {
    if (!file) {
      setError('Please select a file to import');
      return;
    }

    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
      setError('Please select an Excel file (.xlsx or .xls)');
      return;
    }

    try {
      setLoading(true);
      setError('');
      setSuccess('');
      const response = await importExport.import(file);
      setImportResult(response.data);
      setSuccess(`Successfully imported ${response.data.imported_records} records!`);
      setFile(null);
      document.getElementById('fileInput').value = '';
    } catch (error) {
      setError(error.response?.data?.error || 'Import failed');
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  const downloadFile = async (exportFunction, filename) => {
    try {
      setLoading(true);
      const response = await exportFunction();
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.parentElement.removeChild(link);
      window.URL.revokeObjectURL(url);
      setSuccess(`${filename} downloaded successfully!`);
    } catch (error) {
      setError(`Failed to download ${filename}`);
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <div className="card">
        <div className="card-header">
          <h2>Import / Export</h2>
        </div>

        {error && <div className="alert alert-danger">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {/* Import Section */}
        <div className="card" style={{ backgroundColor: '#f9fafb', marginBottom: '30px' }}>
          <h3>📥 Import Excel File</h3>
          <p style={{ color: '#6b7280', marginBottom: '20px' }}>
            Upload an Excel file to import members, payments, withdrawals, and transactions.
          </p>

          <div className="form-group">
            <label>Select Excel File</label>
            <input
              id="fileInput"
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileSelect}
              disabled={loading}
              style={{ padding: '10px', border: '2px dashed #d1d5db' }}
            />
            {file && <p style={{ marginTop: '10px', color: '#10b981' }}>✓ Selected: {file.name}</p>}
          </div>

          <button
            className="btn-primary"
            onClick={handleImport}
            disabled={loading || !file}
          >
            {loading ? 'Importing...' : 'Import File'}
          </button>

          {importResult && (
            <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#d1fae5', borderRadius: '4px' }}>
              <h4>Import Result:</h4>
              <p>Records imported: <strong>{importResult.imported_records}</strong></p>
              {importResult.errors && importResult.errors.length > 0 && (
                <div>
                  <p style={{ color: '#ef4444' }}>Errors:</p>
                  <ul>
                    {importResult.errors.map((error, index) => (
                      <li key={index}>{error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Export Section */}
        <div className="card" style={{ backgroundColor: '#f9fafb' }}>
          <h3>📥 Export Data</h3>
          <p style={{ color: '#6b7280', marginBottom: '20px' }}>
            Download your data as Excel files for backup or analysis.
          </p>

          <div className="grid">
            <div className="card">
              <h4>Members List</h4>
              <p style={{ fontSize: '12px', color: '#6b7280' }}>
                Export all members with their total paid, withdrawn, and balance.
              </p>
              <button
                className="btn-success"
                onClick={() => downloadFile(importExport.exportMembers, 'members.xlsx')}
                disabled={loading}
                style={{ width: '100%' }}
              >
                {loading ? 'Downloading...' : 'Download Members'}
              </button>
            </div>

            <div className="card">
              <h4>Monthly Payments</h4>
              <p style={{ fontSize: '12px', color: '#6b7280' }}>
                Export all payment records with dates, amounts, and status.
              </p>
              <button
                className="btn-success"
                onClick={() => downloadFile(importExport.exportPayments, 'payments.xlsx')}
                disabled={loading}
                style={{ width: '100%' }}
              >
                {loading ? 'Downloading...' : 'Download Payments'}
              </button>
            </div>

            <div className="card">
              <h4>Withdrawals</h4>
              <p style={{ fontSize: '12px', color: '#6b7280' }}>
                Export all withdrawal records with reasons and amounts.
              </p>
              <button
                className="btn-success"
                onClick={() => downloadFile(importExport.exportWithdrawals, 'withdrawals.xlsx')}
                disabled={loading}
                style={{ width: '100%' }}
              >
                {loading ? 'Downloading...' : 'Download Withdrawals'}
              </button>
            </div>

            <div className="card">
              <h4>Transactions</h4>
              <p style={{ fontSize: '12px', color: '#6b7280' }}>
                Export complete transaction history with balances.
              </p>
              <button
                className="btn-success"
                onClick={() => downloadFile(importExport.exportTransactions, 'transactions.xlsx')}
                disabled={loading}
                style={{ width: '100%' }}
              >
                {loading ? 'Downloading...' : 'Download Transactions'}
              </button>
            </div>

            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <h4>📊 Complete Report</h4>
              <p style={{ fontSize: '12px', color: '#6b7280', marginBottom: '15px' }}>
                Export a complete report with all data (members, payments, withdrawals, and transactions in separate sheets).
              </p>
              <button
                className="btn-success"
                onClick={() => downloadFile(importExport.exportCompleteReport, 'complete_report.xlsx')}
                disabled={loading}
                style={{ width: '100%' }}
              >
                {loading ? 'Downloading...' : 'Download Complete Report'}
              </button>
            </div>
          </div>
        </div>

        {/* Instructions */}
        <div className="card" style={{ backgroundColor: '#dbeafe', marginTop: '30px' }}>
          <h3>📋 Instructions</h3>
          <div style={{ fontSize: '14px', lineHeight: '1.8' }}>
            <h4>Importing Data:</h4>
            <ul style={{ marginLeft: '20px' }}>
              <li>Prepare your Excel file with columns: DATE, NAME, AMOUNT, SATATUS, PAYMENT MODE, etc.</li>
              <li>The DATE column should contain dates in Excel format</li>
              <li>The NAME column should contain member names exactly as you want them stored</li>
              <li>Click "Import File" to upload and process the data</li>
            </ul>

            <h4 style={{ marginTop: '15px' }}>Exporting Data:</h4>
            <ul style={{ marginLeft: '20px' }}>
              <li>Use individual export buttons to download specific data sets</li>
              <li>Use "Complete Report" to export everything in one file with multiple sheets</li>
              <li>All exports include formatted numbers with currency symbol</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ImportExport;
